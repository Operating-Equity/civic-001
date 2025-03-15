import requests
import json
import time
import logging
import traceback
import os
from youtube_transcript_api import YouTubeTranscriptApi, TranscriptsDisabled, NoTranscriptFound
import assemblyai as aai
from flask import current_app
from pytube import YouTube
import whisper

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

def transcribe_audio_with_whisper(audio_file):
    """
    Transcribes the given audio file using the Whisper model.
    
    Parameters:
        audio_file (str): Path to the audio file.
        
    Returns:
        str: The transcribed text.
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
            
        logger.info(f"Successfully transcribed audio with {len(transcript_text)} characters")
        return transcript_text
        
    except Exception as e:
        logger.error(f"Error transcribing with Whisper: {str(e)}\n{traceback.format_exc()}")
        raise Exception(f"Failed to transcribe audio: {str(e)}")
    
def get_youtube_transcript(video_id, languages=['en']):
    """
    Fetch transcript from a YouTube video using the YouTube Transcript API.
    If that fails, falls back to downloading the audio and using Whisper for transcription.
    
    Parameters:
        video_id (str): The YouTube video ID.
        languages (list): A list of language codes to try for the transcript (default is ['en']).
    
    Returns:
        tuple: (transcript_text, video_title)
    
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
            video_title = f"YouTube Video ({video_id})"
            
            logger.info(f"Successfully fetched transcript using captions for {video_id}")
            return transcript_text, video_title
            
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
            # Transcribe audio
            transcript_text = transcribe_audio_with_whisper(audio_path)
            
            logger.info(f"Successfully transcribed using pytube + Whisper fallback for {video_id}")
            return transcript_text, video_title
            
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

def get_video_transcript(file_path):
    """
    Extract transcript from an uploaded video file using AssemblyAI.
    
    Parameters:
        file_path (str): Path to the video file.
        
    Returns:
        str: The transcribed text from the video.
    
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
        
        assembly_ai_key = current_app.config.get('ASSEMBLY_AI_KEY')
        if not assembly_ai_key:
            logger.error("ASSEMBLY_AI_KEY is not configured")
            raise Exception("ASSEMBLY_AI_KEY is not configured in the application")
            
        aai.settings.api_key = assembly_ai_key
        
        try:
            logger.info("Initializing AssemblyAI transcriber")
            transcriber = aai.Transcriber()
            
            logger.info("Starting transcription with AssemblyAI")
            transcript = transcriber.transcribe(file_path)
            
            logger.info("Transcription completed, checking results")
            if not transcript or not hasattr(transcript, 'text') or not transcript.text:
                logger.error("Transcription resulted in empty text")
                raise Exception("Transcription resulted in empty text")
                
            logger.info(f"Successfully transcribed file with {len(transcript.text)} characters")
            return transcript.text
                
        except aai.exceptions.AuthorizationError:
            logger.error("AssemblyAI authorization error - invalid API key")
            raise Exception("Invalid AssemblyAI API key")
            
        except aai.exceptions.RequestTimeoutError:
            logger.error("AssemblyAI request timed out")
            raise Exception("Transcription service timed out. Please try again with a shorter video.")
            
    except Exception as e:
        error_message = f"Failed to transcribe video file: {str(e)}"
        logger.error(f"{error_message}\n{traceback.format_exc()}")
        raise Exception("Unable to process this video file. Please ensure it contains audio and is in a supported format.")