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
    """Validates if the video ID has the correct format (typically 11 chars)"""
    return video_id and isinstance(video_id, str) and len(video_id) >= 11

def get_youtube_transcript(video_id):
    """
    Fetch transcript from YouTube video using YouTube Transcript API.
    If unavailable, fall back to using the RapidAPI service.
    """
    if not is_valid_youtube_id(video_id):
        raise ValueError(f"Invalid YouTube video ID format: {video_id}")
        
    logger.info(f"Fetching transcript for YouTube video ID: {video_id}")
    primary_error = None
    
    # First attempt with YouTubeTranscriptApi with retries
    for attempt in range(3):  # Try up to 3 times
        try:
            logger.info(f"YouTubeTranscriptApi attempt {attempt+1}/3")
            transcript_list = YouTubeTranscriptApi.get_transcript(video_id)
            
            if not transcript_list:
                logger.warning(f"Empty transcript returned for video ID {video_id}")
                raise Exception("Empty transcript returned")
                
            transcript_text = " ".join([item['text'] for item in transcript_list])
            
            # For title, we need to query YouTube API or scrape
            # Using a placeholder for now
            video_title = f"YouTube Video ({video_id})"
            
            logger.info(f"Successfully fetched transcript via YouTubeTranscriptApi for {video_id}")
            return transcript_text, video_title
            
        except (TranscriptsDisabled, NoTranscriptFound) as e:
            # No transcript available, don't retry but move to fallback
            primary_error = str(e)
            logger.warning(f"No transcript available for {video_id}: {primary_error}")
            break
            
        except Exception as e:
            # Other errors - network issues, etc.
            primary_error = str(e)
            logger.warning(f"Error in YouTubeTranscriptApi attempt {attempt+1}: {primary_error}")
            if attempt < 2:  # Don't sleep on the last attempt
                time.sleep(2)  # Slightly longer delay before retry
    
    # Fall back to RapidAPI service
    try:
        logger.info(f"Falling back to RapidAPI for {video_id}")
        rapid_api_key = current_app.config.get('RAPIDAPI_KEY', '')
        if not rapid_api_key:
            logger.error("RAPIDAPI_KEY is not configured")
            raise Exception("RAPIDAPI_KEY is not configured")
            
        headers = {
            'x-rapidapi-host': 'youtube-transcriptor.p.rapidapi.com',
            'x-rapidapi-key': rapid_api_key
        }
        
        # Increase timeout to avoid 502 errors
        try:
            logger.info(f"Sending request to RapidAPI for {video_id}")
            response = requests.get(
                f"https://youtube-transcriptor.p.rapidapi.com/transcript?video_id={video_id}&lang=en",
                headers=headers,
                timeout=90  # 90 second timeout
            )
            
            response.raise_for_status()  # Raise exception for 4XX/5XX status codes
            
            # Log response for debugging
            logger.info(f"RapidAPI response status: {response.status_code}")
            response_text = response.text[:500] + "..." if len(response.text) > 500 else response.text
            logger.info(f"RapidAPI response preview: {response_text}")
            
            data = response.json()
            
            # More detailed logging and validation
            if not data:
                logger.error(f"Empty response from RapidAPI for {video_id}")
                raise Exception("No transcript data available for this video")
            
            if not isinstance(data, list):
                logger.error(f"Unexpected response format from RapidAPI for {video_id}: not a list")
                logger.error(f"Response type: {type(data)}")
                # Try to handle non-list response if possible
                if isinstance(data, dict) and data.get('transcription'):
                    # Convert to expected format
                    data = [data]
                else:
                    raise Exception("Unexpected response format from RapidAPI")
            
            if len(data) == 0:
                logger.error(f"Empty list response from RapidAPI for {video_id}")
                raise Exception("No transcript data available for this video")
                
            # Try to extract title and handle potential missing fields
            try:
                video_title = data[0].get('title', f"YouTube Video ({video_id})")
                
                # Check for transcription data with more detailed logging
                if not data[0].get('transcription'):
                    logger.error(f"No 'transcription' field in RapidAPI response for {video_id}")
                    logger.error(f"Available fields: {list(data[0].keys())}")
                    
                    # Try alternative fields that might contain transcript data
                    alternate_fields = ['transcript', 'subtitles', 'captions', 'text']
                    found_field = None
                    
                    for field in alternate_fields:
                        if field in data[0] and data[0][field]:
                            found_field = field
                            logger.info(f"Found alternative transcript field: {field}")
                            break
                    
                    if found_field:
                        # Handle the alternative field format
                        if isinstance(data[0][found_field], list):
                            segments = data[0][found_field]
                            if segments and isinstance(segments[0], dict):
                                # Try to find text content in different possible keys
                                text_keys = ['subtitle', 'text', 'content', 'caption']
                                for key in text_keys:
                                    if key in segments[0]:
                                        transcript_text = " ".join([s.get(key, '') for s in segments])
                                        break
                            else:
                                # If segments are strings, join them directly
                                transcript_text = " ".join([str(s) for s in segments])
                        elif isinstance(data[0][found_field], str):
                            # If it's already a string, use it directly
                            transcript_text = data[0][found_field]
                        else:
                            raise Exception("Cannot parse alternative transcript field format")
                    else:
                        raise Exception("No transcription data in API response")
                else:
                    # Process transcription normally
                    transcription = data[0].get('transcription', [])
                    logger.info(f"Found {len(transcription)} transcript segments")
                    
                    # Sample the first segment to understand its structure
                    if transcription and len(transcription) > 0:
                        logger.info(f"First segment sample: {str(transcription[0])[:100]}")
                    
                    transcript_text = " ".join(
                        [segment.get('subtitle', '') for segment in transcription]
                    )
            except (KeyError, IndexError, TypeError) as e:
                logger.error(f"Error parsing RapidAPI response: {str(e)}")
                logger.error(f"Response structure: {str(data)[:500]}")
                raise Exception(f"Failed to parse transcript data: {str(e)}")
            
            # Validate the extracted transcript
            if not transcript_text or transcript_text.strip() == "":
                logger.error(f"Empty transcript text from RapidAPI for {video_id}")
                
                # Try one more approach - direct text extraction if available
                if isinstance(data[0], dict) and 'text' in data[0]:
                    transcript_text = data[0]['text']
                    if transcript_text and transcript_text.strip() != "":
                        logger.info("Successfully extracted transcript from 'text' field")
                    else:
                        raise Exception("Empty transcript result after fallback attempt")
                else:
                    raise Exception("Empty transcript result")
                
            logger.info(f"Successfully fetched transcript via RapidAPI for {video_id}")
            return transcript_text, video_title
            
        except requests.exceptions.Timeout:
            logger.error(f"RapidAPI request timed out for {video_id}")
            raise Exception("RapidAPI request timed out")
            
        except requests.exceptions.HTTPError as http_err:
            logger.error(f"RapidAPI HTTP error for {video_id}: {http_err}")
            raise Exception(f"RapidAPI returned status code {response.status_code}")
            
    except Exception as fallback_error:
        error_message = f"Failed to get YouTube transcript: {primary_error}. Fallback also failed: {str(fallback_error)}"
        logger.error(f"{error_message}\n{traceback.format_exc()}")
        
        # Return a user-friendly error
        raise Exception("Unable to process this YouTube video. The video may be unavailable or have no transcript.")

def get_video_transcript(file_path):
    """
    Extract transcript from uploaded video file using AssemblyAI.
    """
    try:
        logger.info(f"Starting transcription for file: {file_path}")
        
        # Validate file
        import os
        if not os.path.exists(file_path):
            logger.error(f"File does not exist: {file_path}")
            raise FileNotFoundError(f"File not found: {file_path}")
            
        if not os.path.isfile(file_path):
            logger.error(f"Path is not a file: {file_path}")
            raise ValueError("Path is not a valid file")
            
        # Check file size
        file_size = os.path.getsize(file_path)
        logger.info(f"File size: {file_size / (1024*1024):.2f} MB")
        
        # 100MB is our configured limit
        if file_size > 100 * 1024 * 1024:
            logger.error(f"File exceeds size limit: {file_size / (1024*1024):.2f} MB")
            raise ValueError("File exceeds the maximum size limit of 100MB")
        
        # Set your API key
        assembly_ai_key = current_app.config.get('ASSEMBLY_AI_KEY')
        if not assembly_ai_key:
            logger.error("ASSEMBLY_AI_KEY is not configured")
            raise Exception("ASSEMBLY_AI_KEY is not configured in the application")
            
        aai.settings.api_key = assembly_ai_key
        
        try:
            # Create a transcriber instance
            logger.info("Initializing AssemblyAI transcriber")
            transcriber = aai.Transcriber()
            
            # Transcribe the audio file with increased timeout
            # Note: AssemblyAI handles large files by streaming and has its own retry logic
            logger.info("Starting transcription with AssemblyAI")
            transcript = transcriber.transcribe(file_path)
            
            logger.info("Transcription completed, checking results")
            
            # Check if transcription is complete
            if not transcript or not hasattr(transcript, 'text') or not transcript.text:
                logger.error("Transcription resulted in empty text")
                raise Exception("Transcription resulted in empty text")
                
            # Return the transcript text
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
        
        # Return a user-friendly error
        raise Exception("Unable to process this video file. Please ensure it contains audio and is in a supported format.")
