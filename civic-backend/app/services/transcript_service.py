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
    
    # Fall back to RapidAPI services - will try two different endpoints
    try:
        logger.info(f"Falling back to RapidAPI for {video_id}")
        rapid_api_key = current_app.config.get('RAPIDAPI_KEY', '')
        if not rapid_api_key:
            logger.error("RAPIDAPI_KEY is not configured")
            raise Exception("RAPIDAPI_KEY is not configured")
        
        # Try first RapidAPI endpoint
        try:
            logger.info(f"Trying first RapidAPI endpoint for {video_id}")
            headers = {
                'x-rapidapi-host': 'youtube-transcriptor.p.rapidapi.com',
                'x-rapidapi-key': rapid_api_key
            }
            
            # Increase timeout to avoid 502 errors
            logger.info(f"Sending request to primary RapidAPI endpoint for {video_id}")
            response = requests.get(
                f"https://youtube-transcriptor.p.rapidapi.com/transcript?video_id={video_id}&lang=en",
                headers=headers,
                timeout=90  # 90 second timeout
            )
            
            response.raise_for_status()  # Raise exception for 4XX/5XX status codes
            
            # Log response for debugging
            logger.info(f"Primary RapidAPI endpoint response status: {response.status_code}")
            response_text = response.text[:500] + "..." if len(response.text) > 500 else response.text
            logger.info(f"Primary RapidAPI endpoint response preview: {response_text}")
            
            # Parse response data
            try:
                data = response.json()
            except json.JSONDecodeError as e:
                logger.error(f"JSON parse error from primary RapidAPI endpoint: {str(e)}")
                logger.error(f"Response content: {response.text[:500]}")
                data = None  # Will be caught by the next validation check
            
            # Validate response data
            if not data:
                logger.error(f"Empty response from primary RapidAPI endpoint for {video_id}")
                raise Exception("No transcript data from primary endpoint")
            
            if not isinstance(data, list):
                logger.error(f"Unexpected response format from primary RapidAPI endpoint: not a list")
                logger.error(f"Response type: {type(data)}")
                # Try to handle non-list response if possible
                if isinstance(data, dict) and data.get('transcription'):
                    # Convert to expected format
                    data = [data]
                else:
                    raise Exception("Unexpected response format from primary endpoint")
            
            if len(data) == 0:
                logger.error(f"Empty list response from primary RapidAPI endpoint for {video_id}")
                raise Exception("No transcript data from primary endpoint")
            # Process first endpoint response    
            try:
                # Try to extract title and handle potential missing fields
                video_title = data[0].get('title', f"YouTube Video ({video_id})")
                
                # Check for transcription data with more detailed logging
                if not data[0].get('transcription'):
                    logger.error(f"No 'transcription' field in primary RapidAPI response")
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
                        raise Exception("No transcription data in primary API response")
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
                logger.error(f"Error parsing primary RapidAPI response: {str(e)}")
                logger.error(f"Response structure: {str(data)[:500]}")
                raise Exception(f"Failed to parse transcript data from primary endpoint: {str(e)}")
            
            # Validate the extracted transcript
            if not transcript_text or transcript_text.strip() == "":
                logger.error(f"Empty transcript text from primary RapidAPI endpoint")
                
                # Try one more approach - direct text extraction if available
                if isinstance(data[0], dict) and 'text' in data[0]:
                    transcript_text = data[0]['text']
                    if transcript_text and transcript_text.strip() != "":
                        logger.info("Successfully extracted transcript from 'text' field")
                    else:
                        raise Exception("Empty transcript result after first fallback attempt")
                else:
                    raise Exception("Empty transcript result from primary endpoint")
            
            # If we got here, we have a valid transcript from the first endpoint
            logger.info(f"Successfully fetched transcript via primary RapidAPI endpoint")
            return transcript_text, video_title
                
        except Exception as first_api_error:
            # First RapidAPI endpoint failed, try the second one
            logger.warning(f"First RapidAPI endpoint failed: {str(first_api_error)}")
            logger.info(f"Trying second RapidAPI endpoint for {video_id}")
            
            try:
                # Different RapidAPI endpoint with different host and URL structure
                alt_headers = {
                    'x-rapidapi-host': 'youtube-transcript-api.p.rapidapi.com',
                    'x-rapidapi-key': rapid_api_key
                }
                
                logger.info(f"Sending request to alternative RapidAPI endpoint for {video_id}")
                alt_response = requests.get(
                    f"https://youtube-transcript-api.p.rapidapi.com/retrieve?video_id={video_id}&lang=en",
                    headers=alt_headers,
                    timeout=90
                )
                
                alt_response.raise_for_status()
                
                # Log alternative endpoint response
                logger.info(f"Alternative RapidAPI endpoint response status: {alt_response.status_code}")
                alt_response_text = alt_response.text[:500] + "..." if len(alt_response.text) > 500 else alt_response.text
                logger.info(f"Alternative RapidAPI endpoint response preview: {alt_response_text}")
                
                try:
                    alt_data = alt_response.json()
                except json.JSONDecodeError as e:
                    logger.error(f"JSON parse error from alternative RapidAPI endpoint: {str(e)}")
                    logger.error(f"Response content: {alt_response.text[:500]}")
                    raise Exception("Failed to parse JSON from alternative endpoint")
                
                # This endpoint typically returns an array of transcript segments
                if not alt_data:
                    logger.error("Empty response from alternative RapidAPI endpoint")
                    raise Exception("No transcript data from alternative endpoint")
                
                # Look for different response formats this endpoint might return
                if isinstance(alt_data, list):
                    # Direct list of transcript segments
                    segments = alt_data
                    logger.info(f"Found {len(segments)} transcript segments in alternative endpoint response")
                    
                    # Check the structure of segments to extract text correctly
                    if segments and isinstance(segments[0], dict):
                        # Extract text from segments - try different possible field names
                        text_fields = ['text', 'content', 'caption', 'subtitle']
                        found_field = None
                        
                        for field in text_fields:
                            if field in segments[0]:
                                found_field = field
                                break
                        
                        if found_field:
                            alt_transcript_text = " ".join([s.get(found_field, '') for s in segments])
                        else:
                            # If no recognized field is found, log the structure and try the first key
                            logger.warning(f"Unknown segment structure: {list(segments[0].keys())}")
                            first_key = list(segments[0].keys())[0] if segments[0] else None
                            if first_key:
                                alt_transcript_text = " ".join([s.get(first_key, '') for s in segments])
                            else:
                                raise Exception("Could not find text content in transcript segments")
                    else:
                        # If segments are not dictionaries, try joining them directly
                        alt_transcript_text = " ".join([str(s) for s in segments])
                
                elif isinstance(alt_data, dict):
                    # Check if data is inside a container field
                    container_fields = ['transcript', 'captions', 'subtitles', 'segments']
                    found_container = None
                    
                    for field in container_fields:
                        if field in alt_data and isinstance(alt_data[field], list) and alt_data[field]:
                            found_container = field
                            break
                    
                    if found_container:
                        # Process list inside container field
                        segments = alt_data[found_container]
                        
                        if isinstance(segments[0], dict):
                            # Find text field in segment dictionary
                            text_fields = ['text', 'content', 'caption', 'subtitle']
                            found_field = None
                            
                            for field in text_fields:
                                if field in segments[0]:
                                    found_field = field
                                    break
                            
                            if found_field:
                                alt_transcript_text = " ".join([s.get(found_field, '') for s in segments])
                            else:
                                # If no recognized field, try the first key
                                first_key = list(segments[0].keys())[0] if segments[0] else None
                                if first_key:
                                    alt_transcript_text = " ".join([s.get(first_key, '') for s in segments])
                                else:
                                    raise Exception("Could not find text content in alternative endpoint response")
                        else:
                            # If segments are strings, join them directly
                            alt_transcript_text = " ".join([str(s) for s in segments])
                    elif 'text' in alt_data:
                        # Direct text field
                        alt_transcript_text = alt_data['text']
                    else:
                        # Log available fields to help debug
                        logger.error(f"Unknown response structure from alternative endpoint: {list(alt_data.keys())}")
                        raise Exception("Could not extract transcript from alternative endpoint response")
                else:
                    logger.error(f"Unexpected response type from alternative endpoint: {type(alt_data)}")
                    raise Exception("Unexpected response format from alternative RapidAPI endpoint")
                
                # Validate the alternative transcript
                if not alt_transcript_text or alt_transcript_text.strip() == "":
                    logger.error("Empty transcript text from alternative RapidAPI endpoint")
                    raise Exception("Empty transcript result from alternative endpoint")
                
                # Use a generic title since the alternative API might not provide one
                alt_video_title = f"YouTube Video ({video_id})"
                
                logger.info(f"Successfully fetched transcript via alternative RapidAPI endpoint")
                return alt_transcript_text, alt_video_title
                
            except requests.exceptions.Timeout:
                logger.error(f"Alternative RapidAPI request timed out for {video_id}")
                raise Exception("Alternative RapidAPI request timed out")
                
            except requests.exceptions.HTTPError as http_err:
                logger.error(f"Alternative RapidAPI HTTP error: {http_err}")
                raise Exception(f"Alternative RapidAPI returned status code {alt_response.status_code}")
                
            except Exception as alt_api_error:
                logger.error(f"Alternative RapidAPI endpoint failed: {str(alt_api_error)}")
                # Re-raise the original error since both endpoints failed
                raise Exception(f"Both RapidAPI endpoints failed. First error: {str(first_api_error)}")
        except requests.exceptions.Timeout:
            logger.error(f"Primary RapidAPI request timed out for {video_id}")
            raise Exception("Primary RapidAPI request timed out")
            
        except requests.exceptions.HTTPError as http_err:
            logger.error(f"Primary RapidAPI HTTP error: {http_err}")
            raise Exception(f"Primary RapidAPI returned status code {response.status_code}")
            
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
