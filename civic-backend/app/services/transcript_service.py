import requests
import json
import time
import logging
import traceback
import os
import tempfile
from youtube_transcript_api import YouTubeTranscriptApi, TranscriptsDisabled, NoTranscriptFound
import assemblyai as aai
from flask import current_app
from pytube import YouTube
import whisper
import numpy as np
import concurrent.futures

# Set up logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

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
        str: Path to the downloaded audio file.
    """
    try:
        logger.info(f"Downloading audio for YouTube video ID: {video_id}")
        
        # Create YouTube object
        video_url = f"https://www.youtube.com/watch?v={video_id}"
        yt = YouTube(video_url)
        
        # Get title for better logging
        video_title = yt.title
        logger.info(f"Video title: {video_title}")
        
        # Select the first audio-only stream available
        audio_stream = yt.streams.filter(only_audio=True).first()
        
        if not audio_stream:
            logger.error(f"No audio stream found for video {video_id}")
            raise Exception("No audio stream found for this video")
        
        # Set output directory and filename
        if not output_dir:
            output_dir = os.path.join(current_app.config['UPLOAD_FOLDER'], 'temp_audio')
            
        # Create directory if it doesn't exist
        os.makedirs(output_dir, exist_ok=True)
        
        # Download audio stream
        output_path = os.path.join(output_dir, f"{video_id}.mp4")
        logger.info(f"Downloading audio to {output_path}")
        
        audio_stream.download(output_path=output_dir, filename=f"{video_id}.mp4")
        
        # Check if file was successfully downloaded
        if not os.path.exists(output_path):
            logger.error(f"Failed to download audio for {video_id}")
            raise Exception("Failed to download audio")
            
        logger.info(f"Successfully downloaded audio for {video_id}")
        return output_path, video_title
        
    except Exception as e:
        logger.error(f"Error downloading audio from YouTube: {str(e)}\n{traceback.format_exc()}")
        raise Exception(f"Failed to download audio: {str(e)}")

def transcribe_audio_with_whisper(audio_file, with_speakers=False):
    """
    Transcribes the given audio file using the Whisper model.
    
    Parameters:
        audio_file (str): Path to the audio file.
        with_speakers (bool): Whether to attempt speaker diarization
        
    Returns:
        dict: Transcription with text and optional speaker data
    """
    try:
        logger.info(f"Transcribing audio with Whisper: {audio_file}")
        
        # Load the Whisper model (base is a good balance between speed and accuracy)
        model_size = "base"
        logger.info(f"Loading Whisper model: {model_size}")
        model = whisper.load_model(model_size)
        
        # Run transcription
        logger.info("Starting transcription with Whisper")
        result = model.transcribe(audio_file)
        
        transcript_text = result.get("text", "")
        
        if not transcript_text or not transcript_text.strip():
            logger.error("Whisper returned empty transcript")
            raise Exception("Transcription resulted in empty text")
        
        # If speaker identification is requested and available, process it
        speaker_data = None
        if with_speakers:
            try:
                speaker_data = identify_speakers(audio_file, result)
            except Exception as speaker_error:
                logger.error(f"Speaker identification failed: {str(speaker_error)}")
                # Continue without speaker data if it fails
        
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
    Identify speakers in an audio file using AssemblyAI's speaker diarization
    
    Parameters:
        audio_file (str): Path to the audio file
        whisper_result (dict): Optional pre-processed Whisper result for timestamp alignment
        
    Returns:
        dict: Speaker identification data with segments
    """
    assembly_ai_key = current_app.config.get('ASSEMBLY_AI_KEY')
    if not assembly_ai_key:
        logger.error("ASSEMBLY_AI_KEY is not configured")
        raise Exception("AssemblyAI API key not configured")
        
    aai.settings.api_key = assembly_ai_key
    
    try:
        logger.info("Initializing AssemblyAI Speaker Diarization")
        transcriber = aai.Transcriber()
        
        # Configure for speaker diarization
        config = aai.TranscriptionConfig(
            speaker_labels=True,  # Enable speaker diarization
            audio_start_from=0,   # Start from beginning
            language_detection=True # Auto-detect language
        )
        
        # Start transcription with diarization
        logger.info("Starting transcription with Speaker Diarization")
        transcript = transcriber.transcribe(audio_file, config)
        
        # Check if diarization was successful
        if not transcript or not hasattr(transcript, 'utterances') or not transcript.utterances:
            logger.error("Speaker diarization failed or no speakers identified")
            return None
            
        # Process speakers and map them to transcript portions
        speakers = {}
        segments = []
        
        for utterance in transcript.utterances:
            speaker_id = utterance.speaker
            
            # Add speaker if it's new
            if speaker_id not in speakers:
                speakers[speaker_id] = f"Speaker {chr(65 + len(speakers))}"  # A, B, C, etc.
            
            # Add segment
            segments.append({
                "speaker": speaker_id,
                "start": utterance.start,
                "end": utterance.end,
                "text": utterance.text
            })
        
        # Integrate with Whisper transcript if provided
        if whisper_result and 'segments' in whisper_result:
            # Attempt to align AssemblyAI segments with Whisper segments
            # This is a simplified approach - more complex alignment would be needed in production
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
    Align Whisper segments with speaker diarization results
    
    This is a simplified approach - in production, you would need more sophisticated
    alignment algorithms based on time overlap and text similarity
    
    Parameters:
        whisper_segments (list): Segments from Whisper with timestamps
        diarized_segments (list): Segments from diarization with speaker IDs
        
    Returns:
        list: Combined segments with both text and speaker IDs
    """
    # This is a placeholder for actual alignment logic
    aligned = []
    
    # Map diarized segments by time ranges
    diarized_by_time = {}
    for segment in diarized_segments:
        diarized_by_time[(segment['start'], segment['end'])] = segment
    
    # Try to find matching segments
    for whisper_segment in whisper_segments:
        w_start = whisper_segment.get('start', 0)
        w_end = whisper_segment.get('end', 0)
        
        # Try to find a matching diarized segment
        best_match = None
        best_overlap = 0
        
        for (d_start, d_end), d_segment in diarized_by_time.items():
            # Calculate overlap
            overlap_start = max(w_start, d_start)
            overlap_end = min(w_end, d_end)
            overlap = max(0, overlap_end - overlap_start)
            
            if overlap > best_overlap:
                best_overlap = overlap
                best_match = d_segment
        
        # If a good match is found, combine the data
        if best_match and best_overlap > 0:
            aligned.append({
                "start": w_start,
                "end": w_end,
                "text": whisper_segment.get('text', ''),
                "speaker": best_match.get('speaker')
            })
        else:
            # No matching speaker found
            aligned.append({
                "start": w_start,
                "end": w_end,
                "text": whisper_segment.get('text', ''),
                "speaker": None
            })
    
    return aligned

def get_youtube_transcript(video_id, languages=['en'], with_speakers=False):
    """
    Fetch transcript from a YouTube video using the YouTube Transcript API.
    If that fails, falls back to downloading the audio and using Whisper for transcription.
    
    Parameters:
        video_id (str): The YouTube video ID.
        languages (list): A list of language codes to try for the transcript (default is ['en']).
        with_speakers (bool): Whether to attempt speaker identification
    
    Returns:
        tuple: (transcript_text, video_title, speakers_data)
    
    Raises:
        Exception: If all transcription methods fail.
    """
    if not is_valid_youtube_id(video_id):
        raise ValueError(f"Invalid YouTube video ID format: {video_id}")
        
    logger.info(f"Fetching transcript for YouTube video ID: {video_id}")
    
    # First attempt: Try YouTubeTranscriptApi (captions-based approach)
    for attempt in range(2):  # Reduced from 3 to 2 attempts to save time if captions aren't available
        try:
            logger.info(f"Attempt {attempt+1}/2 using YouTubeTranscriptApi")
            transcript_list = YouTubeTranscriptApi.get_transcript(video_id, languages=languages)
            
            if not transcript_list:
                logger.warning(f"Empty transcript returned for video ID {video_id}")
                break
                
            transcript_text = " ".join([item['text'] for item in transcript_list])
            
            # Get video title separately
            video_url = f"https://www.youtube.com/watch?v={video_id}"
            yt = YouTube(video_url)
            video_title = yt.title
            
            logger.info(f"Successfully fetched transcript using captions for {video_id}")
            
            # If speaker identification is requested, we still need to download the audio
            # since captions don't include speaker information
            speakers_data = None
            if with_speakers:
                try:
                    logger.info("Speaker identification requested, downloading audio for diarization")
                    audio_path, _ = download_audio_from_youtube(video_id)
                    
                    try:
                        # Identify speakers
                        speakers_data = identify_speakers(audio_path)
                        
                        # Clean up audio file after processing
                        if os.path.exists(audio_path):
                            os.remove(audio_path)
                            logger.info(f"Removed temporary audio file: {audio_path}")
                    except Exception as e:
                        logger.error(f"Speaker identification failed: {str(e)}")
                        # Continue without speaker data if it fails
                        
                        # Clean up audio file even if processing fails
                        if os.path.exists(audio_path):
                            os.remove(audio_path)
                except Exception as e:
                    logger.error(f"Failed to get speaker data: {str(e)}")
                    # Continue without speaker data if it fails
            
            return transcript_text, video_title, speakers_data
            
        except (TranscriptsDisabled, NoTranscriptFound) as e:
            logger.warning(f"No transcript available via captions for {video_id}: {str(e)}")
            break  # Break immediately as retrying won't help if captions are disabled
            
        except Exception as e:
            logger.warning(f"Error in YouTubeTranscriptApi attempt {attempt+1}: {str(e)}")
            if attempt < 1:
                time.sleep(2)
    
    # Second attempt: Fallback to pytube + Whisper
    logger.info(f"Attempting fallback method (pytube + Whisper) for {video_id}")
    try:
        # Download audio
        audio_path, video_title = download_audio_from_youtube(video_id)
        
        try:
            # Transcribe audio with optional speaker identification
            transcription_result = transcribe_audio_with_whisper(audio_path, with_speakers)
            transcript_text = transcription_result.get('transcript', '')
            speakers_data = transcription_result.get('speakers_data')
            
            logger.info(f"Successfully transcribed using pytube + Whisper fallback for {video_id}")
            return transcript_text, video_title, speakers_data
            
        finally:
            # Clean up audio file
            try:
                if os.path.exists(audio_path):
                    os.remove(audio_path)
                    logger.info(f"Removed temporary audio file: {audio_path}")
            except Exception as e:
                logger.error(f"Failed to remove temporary audio file {audio_path}: {str(e)}")
                
    except Exception as e:
        logger.error(f"All transcription methods failed for {video_id}: {str(e)}")
        raise Exception(f"Unable to transcribe this video: {str(e)}")

def get_video_transcript(file_path, with_speakers=False):
    """
    Extract transcript from an uploaded video file using AssemblyAI or Whisper.
    Optionally includes speaker identification.
    
    Parameters:
        file_path (str): Path to the video file.
        with_speakers (bool): Whether to attempt speaker identification
        
    Returns:
        dict: Dictionary containing transcript text and optional speaker data
    
    Raises:
        Exception: If the file is invalid, too large, or transcription fails.
    """
    try:
        logger.info(f"Starting transcription for file: {file_path}")
        
        import os
        if not os.path.exists(file_path):
            logger.error(f"File does not exist: {file_path}")
            raise FileNotFoundError(f"File not found: {file_path}")
            
        if not os.path.isfile(file_path):
            logger.error(f"Path is not a file: {file_path}")
            raise ValueError("Path is not a valid file")
            
        file_size = os.path.getsize(file_path)
        logger.info(f"File size: {file_size / (1024*1024):.2f} MB")
        
        # Enforce a 100MB file size limit
        if file_size > 100 * 1024 * 1024:
            logger.error(f"File exceeds size limit: {file_size / (1024*1024):.2f} MB")
            raise ValueError("File exceeds the maximum size limit of 100MB")
        
        # Decide whether to use AssemblyAI or Whisper based on configuration
        use_assemblyai = False
        assembly_ai_key = current_app.config.get('ASSEMBLY_AI_KEY')
        if assembly_ai_key:
            use_assemblyai = True
        
        if use_assemblyai:
            logger.info("Using AssemblyAI for transcription")
            return transcribe_with_assemblyai(file_path, with_speakers)
        else:
            logger.info("Using Whisper for transcription")
            # Create a temporary directory for audio extraction if needed
            with tempfile.TemporaryDirectory() as temp_dir:
                # For now, we'll assume the file is already an audio file
                # In a real implementation, you might need to extract audio from video
                return transcribe_audio_with_whisper(file_path, with_speakers)
                
    except Exception as e:
        error_message = f"Failed to transcribe video file: {str(e)}"
        logger.error(f"{error_message}\n{traceback.format_exc()}")
        raise Exception("Unable to process this video file. Please ensure it contains audio and is in a supported format.")

def transcribe_with_assemblyai(file_path, with_speakers=False):
    """
    Transcribe audio using AssemblyAI with optional speaker diarization.
    
    Parameters:
        file_path (str): Path to the audio/video file
        with_speakers (bool): Whether to enable speaker diarization
        
    Returns:
        dict: Dictionary containing transcript text and optional speaker data
    """
    assembly_ai_key = current_app.config.get('ASSEMBLY_AI_KEY')
    if not assembly_ai_key:
        logger.error("ASSEMBLY_AI_KEY is not configured")
        raise Exception("ASSEMBLY_AI_KEY is not configured in the application")
        
    aai.settings.api_key = assembly_ai_key
    
    try:
        logger.info("Initializing AssemblyAI transcriber")
        transcriber = aai.Transcriber()
        
        # Configure transcription options
        config = aai.TranscriptionConfig(
            speaker_labels=with_speakers,  # Enable speaker diarization if requested
            language_detection=True      # Auto-detect language
        )
        
        logger.info(f"Starting transcription with AssemblyAI (speaker_labels={with_speakers})")
        transcript = transcriber.transcribe(file_path, config)
        
        if not transcript or not hasattr(transcript, 'text') or not transcript.text:
            logger.error("Transcription resulted in empty text")
            raise Exception("Transcription resulted in empty text")
            
        logger.info(f"Successfully transcribed file with {len(transcript.text)} characters")
        
        # Process speaker data if available
        speakers_data = None
        if with_speakers and hasattr(transcript, 'utterances') and transcript.utterances:
            speakers = {}
            segments = []
            
            for utterance in transcript.utterances:
                speaker_id = utterance.speaker
                
                # Add speaker if it's new
                if speaker_id not in speakers:
                    speakers[speaker_id] = f"Speaker {chr(65 + len(speakers))}"  # A, B, C, etc.
                
                # Add segment
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