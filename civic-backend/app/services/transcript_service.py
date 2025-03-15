import os
import re
import time
import json
import logging
import traceback
import tempfile
import subprocess
import numpy as np

import requests
import youtube_transcript_api
from youtube_transcript_api import YouTubeTranscriptApi, TranscriptsDisabled, NoTranscriptFound
import assemblyai as aai
from pytube import YouTube
import whisper

# For text-based speaker identification
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.cluster import KMeans

# If used within a Flask app, current_app provides configuration.
# For standalone testing, you can define a dummy config here.
try:
    from flask import current_app
except ImportError:
    # Standalone fallback config
    class DummyApp:
        config = {
            'UPLOAD_FOLDER': os.path.join(os.getcwd(), 'uploads'),
            'ASSEMBLY_AI_KEY': os.environ.get('ASSEMBLY_AI_KEY', '')
        }
    current_app = DummyApp()

# Set up logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Stub for the external AssemblyAI YouTube integration.
def get_youtube_transcript_via_assemblyai(video_id, with_speakers=False):
    """
    Stub for AssemblyAI YouTube integration.
    Replace this with your actual integration code if available.
    For now, we simulate a failure to force fallback.
    """
    raise NotImplementedError("AssemblyAI YouTube integration is not implemented.")

def is_valid_youtube_id(video_id):
    """Validates if the video ID has the correct format (typically 11+ characters)"""
    return video_id and isinstance(video_id, str) and len(video_id) >= 11

def download_audio_from_youtube(video_id, output_dir=None):
    """
    Downloads the audio stream from a YouTube video.

    Parameters:
        video_id (str): YouTube video ID.
        output_dir (str): Directory to save the downloaded audio.

    Returns:
        tuple: (path to the downloaded audio file, video title)

    Raises:
        Exception: If download fails with details of the failure.
    """
    try:
        logger.info(f"Downloading audio for YouTube video ID: {video_id}")
        video_url = f"https://www.youtube.com/watch?v={video_id}"

        try:
            yt = YouTube(video_url)
        except Exception as yt_error:
            logger.error(f"Failed to create YouTube object: {str(yt_error)}")
            raise Exception(f"Failed to access YouTube video: {str(yt_error)}")

        video_title = f"YouTube Video {video_id}"  # Fallback title
        try:
            if hasattr(yt, 'title') and yt.title:
                video_title = yt.title
                logger.info(f"Video title: {video_title}")
        except Exception as title_error:
            logger.warning(f"Could not get video title, using default: {str(title_error)}")

        # Select the first audio-only stream available using pytube
        try:
            audio_stream = yt.streams.filter(only_audio=True).first()
            if not audio_stream:
                logger.error(f"No audio stream found for video {video_id}")
                raise Exception("No audio stream found for this video")
            
            if not output_dir:
                output_dir = os.path.join(current_app.config.get('UPLOAD_FOLDER', os.getcwd()), 'temp_audio')
            os.makedirs(output_dir, exist_ok=True)
            
            output_filename = f"{video_id}.mp4"  # pytube outputs .mp4 by default
            output_path = os.path.join(output_dir, output_filename)
            logger.info(f"Downloading audio to {output_path}")
            
            audio_stream.download(output_path=output_dir, filename=output_filename)
            if not os.path.exists(output_path):
                logger.error(f"Failed to download audio for {video_id}")
                raise Exception("Failed to download audio file")
            
            logger.info(f"Successfully downloaded audio for {video_id}")
            return output_path, video_title

        except Exception as stream_error:
            logger.error(f"Error downloading audio stream: {str(stream_error)}")
            raise Exception(f"Failed to download audio stream: {str(stream_error)}")

    except Exception as e:
        logger.error(f"Error downloading audio from YouTube: {str(e)}\n{traceback.format_exc()}")
        # Fallback using yt-dlp
        try:
            logger.info(f"Attempting fallback with yt-dlp for {video_id}")
            if not output_dir:
                output_dir = os.path.join(current_app.config.get('UPLOAD_FOLDER', os.getcwd()), 'temp_audio')
            os.makedirs(output_dir, exist_ok=True)
            
            # Use an output template so that yt-dlp names the file correctly
            template = os.path.join(output_dir, f"{video_id}.%(ext)s")
            video_url = f"https://www.youtube.com/watch?v={video_id}"
            cmd = [
                "yt-dlp", 
                "--extract-audio", 
                "--audio-format", "m4a", 
                "--audio-quality", "0",
                "-o", template,
                video_url
            ]
            subprocess.run(cmd, check=True)
            
            # The expected file is video_id.m4a
            fallback_output = os.path.join(output_dir, f"{video_id}.m4a")
            if os.path.exists(fallback_output):
                logger.info(f"Successfully downloaded audio with yt-dlp for {video_id}")
                return fallback_output, f"YouTube Video {video_id}"
            else:
                raise Exception("yt-dlp did not produce the expected output file")
        except Exception as fallback_error:
            logger.error(f"Fallback download also failed: {str(fallback_error)}")
            raise Exception(f"Cannot download audio: YouTube is restricting access to this video")

def get_youtube_transcript(video_id, languages=['en'], with_speakers=False):
    """
    Fetch transcript from a YouTube video using AssemblyAI.
    Falls back to traditional methods if AssemblyAI fails.

    Parameters:
        video_id (str): The YouTube video ID.
        languages (list): A list of language codes to try for the transcript (default is ['en']).
        with_speakers (bool): Whether to attempt speaker identification

    Returns:
        tuple: (transcript_text, video_title) or (transcript_text, video_title, speakers_data)
               if with_speakers=True

    Raises:
        Exception: If all transcription methods fail.
    """
    if not is_valid_youtube_id(video_id):
        raise ValueError(f"Invalid YouTube video ID format: {video_id}")
        
    logger.info(f"Fetching transcript for YouTube video ID: {video_id}")

    # First attempt: Try using AssemblyAI's YouTube integration
    try:
        logger.info(f"Attempting transcription using AssemblyAI YouTube integration for {video_id}")
        if with_speakers:
            transcript_text, video_title, speakers_data = get_youtube_transcript_via_assemblyai(video_id, with_speakers=True)
            return transcript_text, video_title, speakers_data
        else:
            transcript_text, video_title = get_youtube_transcript_via_assemblyai(video_id, with_speakers=False)
            return transcript_text, video_title
    except Exception as e:
        logger.warning(f"AssemblyAI YouTube integration failed: {str(e)}")
        logger.info("Falling back to traditional methods")

    # Second attempt: Use YouTubeTranscriptApi
    for attempt in range(2):
        try:
            logger.info(f"Attempt {attempt+1}/2 using YouTubeTranscriptApi")
            transcript_list = YouTubeTranscriptApi.get_transcript(video_id, languages=languages)
            if not transcript_list:
                logger.warning(f"Empty transcript returned for video ID {video_id}")
                break
            transcript_text = " ".join([item['text'] for item in transcript_list])
            video_title = f"YouTube Video {video_id}"
            try:
                yt = YouTube(f"https://www.youtube.com/watch?v={video_id}")
                if hasattr(yt, 'title') and yt.title:
                    video_title = yt.title
            except Exception as title_error:
                logger.warning(f"Could not get video title, using default: {str(title_error)}")
            
            logger.info(f"Successfully fetched transcript using captions for {video_id}")

            # If speaker identification is requested, download audio and attempt diarization
            speakers_data = None
            if with_speakers:
                try:
                    logger.info("Speaker identification requested, downloading audio for diarization")
                    audio_path, _ = download_audio_from_youtube(video_id)
                    try:
                        speakers_data = identify_speakers(audio_path)
                        if os.path.exists(audio_path):
                            os.remove(audio_path)
                            logger.info(f"Removed temporary audio file: {audio_path}")
                        if not speakers_data:
                            logger.info("Falling back to text-based speaker identification")
                            speakers_data = identify_speakers_from_text(transcript_text)
                    except Exception as e:
                        logger.error(f"Speaker identification failed: {str(e)}")
                        if os.path.exists(audio_path):
                            os.remove(audio_path)
                except Exception as e:
                    logger.error(f"Failed to get speaker data: {str(e)}")
                
                if speakers_data:
                    return transcript_text, video_title, speakers_data
                else:
                    return transcript_text, video_title
            else:
                return transcript_text, video_title

        except (TranscriptsDisabled, NoTranscriptFound) as e:
            logger.warning(f"No transcript available via captions for {video_id}: {str(e)}")
            break
        except Exception as e:
            logger.warning(f"Error in YouTubeTranscriptApi attempt {attempt+1}: {str(e)}")
            if attempt < 1:
                time.sleep(2)

    # Third attempt: Fallback to pytube + Whisper
    logger.info(f"Attempting fallback method (pytube + Whisper) for {video_id}")
    try:
        try:
            audio_path, video_title = download_audio_from_youtube(video_id)
        except Exception as download_error:
            if 'transcript_text' in locals() and 'video_title' in locals():
                logger.warning(f"Audio download failed but transcript available: {str(download_error)}")
                return transcript_text, video_title
            logger.error(f"Failed to download audio: {str(download_error)}")
            if 'transcript_text' in locals() and 'video_title' in locals():
                return transcript_text, video_title
            raise Exception(f"Failed to download audio: {str(download_error)}")
        
        try:
            transcription_result = transcribe_audio_with_whisper(audio_path, with_speakers)
            transcript_text = transcription_result.get('transcript', '')
            speakers_data = transcription_result.get('speakers_data')
            logger.info(f"Successfully transcribed using pytube + Whisper fallback for {video_id}")
            if os.path.exists(audio_path):
                os.remove(audio_path)
                logger.info(f"Removed temporary audio file: {audio_path}")
            if with_speakers and speakers_data:
                return transcript_text, video_title, speakers_data
            else:
                return transcript_text, video_title
        except Exception as transcribe_error:
            if os.path.exists(audio_path):
                os.remove(audio_path)
            logger.error(f"Failed to transcribe audio: {str(transcribe_error)}")
            if 'transcript_text' in locals() and 'video_title' in locals():
                return transcript_text, video_title
            raise Exception(f"Failed to transcribe audio: {str(transcribe_error)}")
    except Exception as e:
        if 'transcript_text' in locals() and 'video_title' in locals():
            logger.warning(f"Using caption transcript due to audio processing failure: {str(e)}")
            return transcript_text, video_title
        logger.error(f"All transcription methods failed for {video_id}: {str(e)}")
        raise Exception(f"Unable to transcribe this video: {str(e)}")

def transcribe_audio_with_whisper(audio_file, with_speakers=False):
    """
    Transcribes the given audio file using the Whisper model.

    Parameters:
        audio_file (str): Path to the audio file.
        with_speakers (bool): Whether to attempt speaker diarization

    Returns:
        dict: Dictionary with keys "transcript" and optionally "speakers_data".
    """
    try:
        logger.info(f"Transcribing audio with Whisper: {audio_file}")
        model_size = "base"
        logger.info(f"Loading Whisper model: {model_size}")
        model = whisper.load_model(model_size)
        logger.info("Starting transcription with Whisper")
        result = model.transcribe(audio_file)
        transcript_text = result.get("text", "")
        if not transcript_text or not transcript_text.strip():
            logger.error("Whisper returned empty transcript")
            raise Exception("Transcription resulted in empty text")
        
        speaker_data = None
        if with_speakers:
            try:
                speaker_data = identify_speakers(audio_file, result)
            except Exception as speaker_error:
                logger.error(f"Speaker identification failed: {str(speaker_error)}")
        logger.info(f"Successfully transcribed audio with {len(transcript_text)} characters")
        return {
            "transcript": transcript_text,
            "speakers_data": speaker_data
        }
    except Exception as e:
        logger.error(f"Error transcribing with Whisper: {str(e)}\n{traceback.format_exc()}")
        raise Exception(f"Failed to transcribe audio: {str(e)}")

def identify_speakers(audio_file, whisper_result=None):
    """
    Identify speakers in an audio file using AssemblyAI's speaker diarization.

    Parameters:
        audio_file (str): Path to the audio file.
        whisper_result (dict): Optional pre-processed Whisper result for timestamp alignment.

    Returns:
        dict: Speaker identification data with segments.
    """
    assembly_ai_key = current_app.config.get('ASSEMBLY_AI_KEY')
    if not assembly_ai_key:
        logger.error("ASSEMBLY_AI_KEY is not configured")
        raise Exception("AssemblyAI API key not configured")
        
    aai.settings.api_key = assembly_ai_key
    try:
        logger.info("Initializing AssemblyAI Speaker Diarization")
        transcriber = aai.Transcriber()
        config = aai.TranscriptionConfig(
            speaker_labels=True,
            audio_start_from=0,
            language_detection=True
        )
        logger.info("Starting transcription with Speaker Diarization")
        transcript = transcriber.transcribe(audio_file, config)
        if not transcript or not hasattr(transcript, 'utterances') or not transcript.utterances:
            logger.error("Speaker diarization failed or no speakers identified")
            return None
        speakers = {}
        segments = []
        for utterance in transcript.utterances:
            speaker_id = utterance.speaker
            if speaker_id not in speakers:
                speakers[speaker_id] = f"Speaker {chr(65 + len(speakers))}"  # A, B, C, etc.
            segments.append({
                "speaker": speaker_id,
                "start": utterance.start,
                "end": utterance.end,
                "text": utterance.text
            })
        if whisper_result and 'segments' in whisper_result:
            aligned_segments = align_segments(whisper_result['segments'], segments)
            if aligned_segments:
                segments = aligned_segments
        logger.info(f"Successfully identified {len(speakers)} speakers in audio")
        return {
            "speakers": speakers,
            "segments": segments
        }
    except Exception as e:
        logger.error(f"Error in speaker identification: {str(e)}")
        raise Exception(f"Speaker identification failed: {str(e)}")

def align_segments(whisper_segments, diarized_segments):
    """
    Align Whisper segments with speaker diarization results.

    Parameters:
        whisper_segments (list): Segments from Whisper with timestamps.
        diarized_segments (list): Segments from diarization with speaker IDs.

    Returns:
        list: Combined segments with both text and speaker IDs.
    """
    aligned = []
    diarized_by_time = {}
    for segment in diarized_segments:
        diarized_by_time[(segment['start'], segment['end'])] = segment
    for whisper_segment in whisper_segments:
        w_start = whisper_segment.get('start', 0)
        w_end = whisper_segment.get('end', 0)
        best_match = None
        best_overlap = 0
        for (d_start, d_end), d_segment in diarized_by_time.items():
            overlap_start = max(w_start, d_start)
            overlap_end = min(w_end, d_end)
            overlap = max(0, overlap_end - overlap_start)
            if overlap > best_overlap:
                best_overlap = overlap
                best_match = d_segment
        if best_match and best_overlap > 0:
            aligned.append({
                "start": w_start,
                "end": w_end,
                "text": whisper_segment.get('text', ''),
                "speaker": best_match.get('speaker')
            })
        else:
            aligned.append({
                "start": w_start,
                "end": w_end,
                "text": whisper_segment.get('text', ''),
                "speaker": None
            })
    return aligned

def get_video_transcript(file_path, with_speakers=False):
    """
    Extract transcript from an uploaded video file using AssemblyAI or Whisper.
    Optionally includes speaker identification.

    Parameters:
        file_path (str): Path to the video file.
        with_speakers (bool): Whether to attempt speaker identification

    Returns:
        dict or str: If with_speakers is True, returns a dict containing the transcript and speaker data.
                     Otherwise, returns just the transcript text.

    Raises:
        Exception: If the file is invalid, too large, or transcription fails.
    """
    try:
        logger.info(f"Starting transcription for file: {file_path}, with speaker identification: {with_speakers}")
        if not os.path.exists(file_path):
            logger.error(f"File does not exist: {file_path}")
            raise FileNotFoundError(f"File not found: {file_path}")
        if not os.path.isfile(file_path):
            logger.error(f"Path is not a file: {file_path}")
            raise ValueError("Path is not a valid file")
        file_size = os.path.getsize(file_path)
        logger.info(f"File size: {file_size / (1024*1024):.2f} MB")
        if file_size > 100 * 1024 * 1024:
            logger.error(f"File exceeds size limit: {file_size / (1024*1024):.2f} MB")
            raise ValueError("File exceeds the maximum size limit of 100MB")
        
        use_assemblyai = False
        assembly_ai_key = current_app.config.get('ASSEMBLY_AI_KEY')
        if assembly_ai_key:
            use_assemblyai = True

        if use_assemblyai:
            logger.info("Using AssemblyAI for transcription")
            result = transcribe_with_assemblyai(file_path, with_speakers)
            if with_speakers:
                return result
            else:
                return result["transcript"]
        else:
            logger.info("Using Whisper for transcription")
            with tempfile.TemporaryDirectory() as temp_dir:
                result = transcribe_audio_with_whisper(file_path, with_speakers)
                if with_speakers:
                    return result
                else:
                    return result["transcript"]
    except Exception as e:
        error_message = f"Failed to transcribe video file: {str(e)}"
        logger.error(f"{error_message}\n{traceback.format_exc()}")
        raise Exception("Unable to process this video file. Please ensure it contains audio and is in a supported format.")

def transcribe_with_assemblyai(file_path, with_speakers=False):
    """
    Transcribe audio using AssemblyAI with optional speaker diarization.

    Parameters:
        file_path (str): Path to the audio/video file.
        with_speakers (bool): Whether to enable speaker diarization.

    Returns:
        dict: Dictionary containing transcript text and optional speaker data.
    """
    assembly_ai_key = current_app.config.get('ASSEMBLY_AI_KEY')
    if not assembly_ai_key:
        logger.error("ASSEMBLY_AI_KEY is not configured")
        raise Exception("ASSEMBLY_AI_KEY is not configured in the application")
        
    aai.settings.api_key = assembly_ai_key
    try:
        logger.info("Initializing AssemblyAI transcriber")
        transcriber = aai.Transcriber()
        config = aai.TranscriptionConfig(
            speaker_labels=with_speakers,
            language_detection=True
        )
        logger.info(f"Starting transcription with AssemblyAI (speaker_labels={with_speakers})")
        transcript = transcriber.transcribe(file_path, config)
        if not transcript or not hasattr(transcript, 'text') or not transcript.text:
            logger.error("Transcription resulted in empty text")
            raise Exception("Transcription resulted in empty text")
        logger.info(f"Successfully transcribed file with {len(transcript.text)} characters")
        speakers_data = None
        if with_speakers and hasattr(transcript, 'utterances') and transcript.utterances:
            speakers = {}
            segments = []
            for utterance in transcript.utterances:
                speaker_id = utterance.speaker
                if speaker_id not in speakers:
                    speakers[speaker_id] = f"Speaker {chr(65 + len(speakers))}"
                segments.append({
                    "speaker": speaker_id,
                    "start": utterance.start,
                    "end": utterance.end,
                    "text": utterance.text
                })
            speakers_data = {
                "speakers": speakers,
                "segments": segments
            }
        return {
            "transcript": transcript.text,
            "speakers_data": speakers_data
        }
    except aai.exceptions.AuthorizationError:
        logger.error("AssemblyAI authorization error - invalid API key")
        raise Exception("Invalid AssemblyAI API key")
    except aai.exceptions.RequestTimeoutError:
        logger.error("AssemblyAI request timed out")
        raise Exception("Transcription service timed out. Please try again with a shorter video.")

def identify_speakers_from_text(transcript, num_speakers=None):
    """
    Text-based speaker identification when audio diarization fails.

    Parameters:
        transcript (str): The transcript text.
        num_speakers (int): Optionally specify the number of speakers.

    Returns:
        dict: Dictionary containing speakers and segmented transcript details, or None on failure.
    """
    segments = re.split(r'\n\n|\.\s+', transcript)
    segments = [s.strip() for s in segments if len(s.strip()) > 20]
    if len(segments) < 10:
        logger.warning("Transcript too short for reliable text-based speaker identification")
        return None
    try:
        if num_speakers is None:
            num_speakers = min(max(2, len(segments) // 30), 5)
        vectorizer = TfidfVectorizer(
            max_features=100, 
            stop_words='english',
            ngram_range=(1, 2)
        )
        X = vectorizer.fit_transform(segments)
        kmeans = KMeans(n_clusters=num_speakers, random_state=42)
        clusters = kmeans.fit_predict(X)
        speaker_segments = []
        speakers = {}
        for i, (segment, cluster_id) in enumerate(zip(segments, clusters)):
            speaker_id = f"speaker_{cluster_id}"
            speaker_name = f"Speaker {chr(65 + cluster_id)}"
            if speaker_id not in speakers:
                speakers[speaker_id] = speaker_name
            duration = max(3, len(segment.split()) * 0.4)
            start = speaker_segments[-1]['end'] if speaker_segments else 0
            end = start + duration
            speaker_segments.append({
                'speaker': speaker_id,
                'start': start,
                'end': end,
                'text': segment
            })
        logger.info(f"Successfully performed text-based speaker identification with {num_speakers} speakers")
        return {
            "speakers": speakers,
            "segments": speaker_segments,
            "method": "text-based"
        }
    except Exception as e:
        logger.error(f"Error in text-based speaker identification: {str(e)}")
        return None