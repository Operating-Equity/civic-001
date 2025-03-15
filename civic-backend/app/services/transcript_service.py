import requests
import json
from youtube_transcript_api import YouTubeTranscriptApi
from assemblyai import AssemblyAI
from flask import current_app

def get_youtube_transcript(video_id):
    """
    Fetch transcript from YouTube video using YouTube Transcript API.
    If unavailable, fall back to using the RapidAPI service.
    """
    try:
        # First attempt with YouTubeTranscriptApi
        transcript_list = YouTubeTranscriptApi.get_transcript(video_id)
        transcript_text = " ".join([item['text'] for item in transcript_list])
        
        # For title, we need to query YouTube API or scrape
        # Using a placeholder for now
        video_title = f"YouTube Video ({video_id})"
        
        return transcript_text, video_title
        
    except Exception as e:
        # Fall back to RapidAPI service
        try:
            headers = {
                'x-rapidapi-host': 'youtube-transcriptor.p.rapidapi.com',
                'x-rapidapi-key': current_app.config.get('RAPIDAPI_KEY', '')
            }
            
            response = requests.get(
                f"https://youtube-transcriptor.p.rapidapi.com/transcript?video_id={video_id}&lang=en",
                headers=headers
            )
            
            if response.status_code != 200:
                raise Exception(f"RapidAPI returned status code {response.status_code}")
                
            data = response.json()
            
            if not data or not isinstance(data, list) or len(data) == 0:
                raise Exception("No transcript data available for this video")
                
            video_title = data[0].get('title', 'Untitled Video')
            transcript_text = " ".join(
                [segment.get('subtitle', '') for segment in data[0].get('transcription', [])]
            )
            
            return transcript_text, video_title
            
        except Exception as fallback_error:
            raise Exception(f"Failed to get YouTube transcript: {str(e)}. Fallback also failed: {str(fallback_error)}")

def get_video_transcript(file_path):
    """
    Extract transcript from uploaded video file using AssemblyAI.
    """
    try:
        client = AssemblyAI(api_key=current_app.config.get('ASSEMBLY_AI_KEY'))
        
        # Upload the file to AssemblyAI
        upload_response = client.transcripts.transcribe_file(file_path)
        
        # Poll until transcription is complete
        transcript_id = upload_response.id
        
        while True:
            transcript = client.transcripts.get(transcript_id)
            if transcript.status == 'completed':
                return transcript.text
            elif transcript.status == 'error':
                raise Exception(f"AssemblyAI error: {transcript.error}")
                
    except Exception as e:
        raise Exception(f"Failed to transcribe video file: {str(e)}")
