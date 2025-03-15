import requests
import json
import time
import logging
import traceback
from youtube_transcript_api import YouTubeTranscriptApi, TranscriptsDisabled, NoTranscriptFound
import assemblyai as aai
from flask import current_app

# Set up logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

def is_valid_youtube_id(video_id):
    """Validates if the video ID has the correct format (typically 11+ characters)"""
    return video_id and isinstance(video_id, str) and len(video_id) >= 11

def get_youtube_transcript(video_id, languages=['en']):
    """
    Fetch transcript from a YouTube video using the YouTube Transcript API.
    Tries up to 3 times before failing. Allows specifying a list of preferred languages.
    
    Parameters:
        video_id (str): The YouTube video ID.
        languages (list): A list of language codes to try for the transcript (default is ['en']).
    
    Returns:
        tuple: (transcript_text, video_title)
    
    Raises:
        Exception: If no transcript is available or an error occurs.
    """
    if not is_valid_youtube_id(video_id):
        raise ValueError(f"Invalid YouTube video ID format: {video_id}")
        
    logger.info(f"Fetching transcript for YouTube video ID: {video_id}")
    
    # Attempt to fetch the transcript up to 3 times
    for attempt in range(3):
        try:
            logger.info(f"Attempt {attempt+1}/3 using YouTubeTranscriptApi")
            transcript_list = YouTubeTranscriptApi.get_transcript(video_id, languages=languages)
            
            if not transcript_list:
                logger.warning(f"Empty transcript returned for video ID {video_id}")
                raise Exception("Empty transcript returned")
                
            transcript_text = " ".join([item['text'] for item in transcript_list])
            video_title = f"YouTube Video ({video_id})"
            
            logger.info(f"Successfully fetched transcript for {video_id}")
            return transcript_text, video_title
            
        except (TranscriptsDisabled, NoTranscriptFound) as e:
            logger.warning(f"No transcript available for {video_id}: {str(e)}")
            raise Exception("No transcript available for this video.")
            
        except Exception as e:
            logger.warning(f"Error in YouTubeTranscriptApi attempt {attempt+1}: {str(e)}")
            if attempt < 2:
                time.sleep(2)
    
    raise Exception("Unable to fetch transcript after multiple attempts.")

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