import requests
import json
import time
from youtube_transcript_api import YouTubeTranscriptApi, TranscriptsDisabled, NoTranscriptFound
import assemblyai as aai
from flask import current_app

def get_youtube_transcript(video_id):
    """
    Fetch transcript from YouTube video using YouTube Transcript API.
    If unavailable, fall back to using the RapidAPI service.
    """
    primary_error = None
    
    # First attempt with YouTubeTranscriptApi with retries
    for attempt in range(3):  # Try up to 3 times
        try:
            transcript_list = YouTubeTranscriptApi.get_transcript(video_id)
            transcript_text = " ".join([item['text'] for item in transcript_list])
            
            # For title, we need to query YouTube API or scrape
            # Using a placeholder for now
            video_title = f"YouTube Video ({video_id})"
            
            return transcript_text, video_title
            
        except (TranscriptsDisabled, NoTranscriptFound) as e:
            # No transcript available, don't retry but move to fallback
            primary_error = str(e)
            break
            
        except Exception as e:
            # Other errors - network issues, etc.
            primary_error = str(e)
            if attempt < 2:  # Don't sleep on the last attempt
                time.sleep(1)  # Short delay before retry
    
    # Fall back to RapidAPI service
    try:
        rapid_api_key = current_app.config.get('RAPIDAPI_KEY', '')
        if not rapid_api_key:
            raise Exception("RAPIDAPI_KEY is not configured")
            
        headers = {
            'x-rapidapi-host': 'youtube-transcriptor.p.rapidapi.com',
            'x-rapidapi-key': rapid_api_key
        }
        
        # Increase timeout to avoid 502 errors
        response = requests.get(
            f"https://youtube-transcriptor.p.rapidapi.com/transcript?video_id={video_id}&lang=en",
            headers=headers,
            timeout=60  # 60 second timeout
        )
        
        if response.status_code != 200:
            raise Exception(f"RapidAPI returned status code {response.status_code}")
            
        data = response.json()
        
        if not data or not isinstance(data, list) or len(data) == 0:
            raise Exception("No transcript data available for this video")
            
        video_title = data[0].get('title', f"YouTube Video ({video_id})")
        transcript_text = " ".join(
            [segment.get('subtitle', '') for segment in data[0].get('transcription', [])]
        )
        
        return transcript_text, video_title
        
    except Exception as fallback_error:
        error_message = f"Failed to get YouTube transcript: {primary_error}. Fallback also failed: {str(fallback_error)}"
        current_app.logger.error(error_message)
        raise Exception(error_message)

def get_video_transcript(file_path):
    """
    Extract transcript from uploaded video file using AssemblyAI.
    """
    try:
        # Set your API key
        assembly_ai_key = current_app.config.get('ASSEMBLY_AI_KEY')
        if not assembly_ai_key:
            raise Exception("ASSEMBLY_AI_KEY is not configured in the application")
            
        aai.settings.api_key = assembly_ai_key
        
        # Create a transcriber instance
        transcriber = aai.Transcriber()
        
        # Transcribe the audio file with increased timeout
        # Note: AssemblyAI handles large files by streaming and has its own retry logic
        transcript = transcriber.transcribe(file_path)
        
        # Check if transcription is complete
        if not transcript.text:
            raise Exception("Transcription resulted in empty text")
            
        # Return the transcript text
        return transcript.text
                
    except Exception as e:
        error_message = f"Failed to transcribe video file: {str(e)}"
        current_app.logger.error(error_message)
        raise Exception(error_message)
