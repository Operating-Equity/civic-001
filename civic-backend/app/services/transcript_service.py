import os
import re
import time
import json
import logging
import traceback
import tempfile
import subprocess
import requests
from flask import current_app
from youtube_transcript_api import YouTubeTranscriptApi, TranscriptsDisabled, NoTranscriptFound
from pytube import YouTube

# Set up logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

def is_valid_youtube_id(video_id):
    """
    Validates if the video ID has the correct format (typically 11+ characters).
    """
    return video_id and isinstance(video_id, str) and len(video_id) >= 11

def extract_video_id(url):
    """
    Extract YouTube video ID from URL.
    """
    # Regular expression patterns for various YouTube URL formats
    patterns = [
        # Standard youtube.com/watch?v=VIDEO_ID pattern
        r'(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/|youtube\.com\/e\/|youtube\.com\/user\/[^\/]+\/[^\/]+\/|youtube\.com\/[^\/]+\/[^\/]+\/|youtube\.com\/shorts\/)([^"&?\/ ]{11})',
        # Alternative pattern for other formats
        r'(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/ ]{11})'
    ]
    
    for pattern in patterns:
        match = re.search(pattern, url, re.IGNORECASE)
        if match:
            return match.group(1)
            
    # Handle live stream URLs specially
    if '/live/' in url:
        match = re.search(r'\/live\/([^?]+)', url)
        if match:
            return match.group(1)
            
    return None

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
                output_dir = os.path.join(
                    current_app.config.get('UPLOAD_FOLDER', os.getcwd()), 
                    'temp_audio'
                )
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
        logger.error(f"Error downloading audio from YouTube: {str(e)}")
        raise Exception(f"Cannot download audio: YouTube is restricting access to this video")

def get_video_title(video_id):
    """
    Get YouTube video title with multiple fallback methods.
    
    Args:
        video_id: YouTube video ID
        
    Returns:
        str: Video title or default if not found
    """
    default_title = f"YouTube Video {video_id}"
    
    # Method 1: Try using pytube with error handling
    try:
        from pytube import YouTube
        yt = YouTube(f"https://www.youtube.com/watch?v={video_id}")
        if hasattr(yt, 'title') and yt.title:
            return yt.title
    except Exception as e:
        logger.warning(f"Failed to get title with pytube: {str(e)}")
    
    # Method 2: Try using youtube-dl / yt-dlp if available
    try:
        import yt_dlp
        ydl_opts = {
            'skip_download': True,
            'quiet': True,
        }
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}", download=False)
            if info and 'title' in info:
                return info['title']
    except Exception as e:
        logger.warning(f"Failed to get title with yt-dlp: {str(e)}")
    
    # Method 3: Try using a simple HTTP request to parse title from HTML
    try:
        import requests
        headers = {
            'User-Agent': (
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                '(KHTML, like Gecko) Chrome/90.0.4430.212 Safari/537.36'
            )
        }
        response = requests.get(f"https://www.youtube.com/watch?v={video_id}", headers=headers, timeout=5)
        if response.status_code == 200:
            title_match = re.search(r'<title>(.*?)</title>', response.text)
            if title_match:
                title = title_match.group(1)
                # Remove " - YouTube" suffix if present
                title = title.replace(" - YouTube", "")
                return title
    except Exception as e:
        logger.warning(f"Failed to get title with HTTP request: {str(e)}")
    
    # If all methods fail, return the default title
    return default_title

def get_youtube_transcript_via_rapidapi(video_id):
    """
    Fetch YouTube transcript using RapidAPI's youtube-transcript service.
    
    Args:
        video_id (str): YouTube video ID
        
    Returns:
        tuple: (transcript_text, video_title) where transcript_text is a string of the full transcript
        
    Raises:
        Exception: If transcript retrieval fails
    """
    # Get API key from environment
    rapidapi_key = current_app.config.get('RAPIDAPI_KEY')
    
    if not rapidapi_key:
        logger.error("RAPIDAPI_KEY is not configured")
        raise Exception("RapidAPI key not configured. Please add RAPIDAPI_KEY to your environment variables.")
    
    try:
        logger.info(f"Fetching transcript from RapidAPI for video ID: {video_id}")
        
        # RapidAPI endpoint and headers
        url = "https://youtube-transcript3.p.rapidapi.com/api/transcript"
        
        querystring = {"videoId": video_id}
        
        headers = {
            "x-rapidapi-key": rapidapi_key,
            "x-rapidapi-host": "youtube-transcript3.p.rapidapi.com"
        }
        
        # Make the request
        response = requests.get(url, headers=headers, params=querystring, timeout=30)
        
        # Check for successful response
        if response.status_code != 200:
            logger.error(f"RapidAPI returned status code {response.status_code}: {response.text}")
            raise Exception(f"Failed to retrieve transcript: HTTP {response.status_code}")
        
        # Parse response
        data = response.json()
        
        if not data.get("success", False):
            error_message = data.get("message", "Unknown error")
            logger.error(f"RapidAPI transcript request failed: {error_message}")
            raise Exception(f"Transcript retrieval failed: {error_message}")
        
        # Extract transcript segments
        transcript_segments = data.get("transcript", [])
        
        if not transcript_segments:
            logger.error("RapidAPI returned empty transcript")
            raise Exception("No transcript segments found in the response")
        
        # Combine transcript segments to create a full transcript
        transcript_text = " ".join(segment.get("text", "") for segment in transcript_segments)
        
        if not transcript_text.strip():
            logger.error("Empty transcript generated from RapidAPI response")
            raise Exception("Generated transcript is empty")
        
        # Get video title using the enhanced method
        video_title = get_video_title(video_id)
        
        logger.info(f"Successfully retrieved transcript via RapidAPI for video ID: {video_id}")
        
        return transcript_text, video_title
        
    except Exception as e:
        logger.error(f"Error fetching transcript from RapidAPI: {str(e)}")
        raise Exception(f"RapidAPI transcript fetching failed: {str(e)}")

def get_youtube_transcript(video_id, languages=['en']):
    """
    Fetch transcript from a YouTube video using two primary methods:
    1. RapidAPI (primary method)
    2. YouTubeTranscriptApi (fallback method)
    
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

    # First attempt: Try using RapidAPI
    try:
        logger.info(f"Attempting transcription using RapidAPI for {video_id}")
        transcript_text, video_title = get_youtube_transcript_via_rapidapi(video_id)
        return transcript_text, video_title
    except Exception as e:
        logger.warning(f"RapidAPI transcription failed: {str(e)}")
        logger.info("Trying YouTubeTranscriptApi as fallback")

    # Second attempt: Use YouTubeTranscriptApi
    for attempt in range(2):
        try:
            logger.info(f"Attempt {attempt+1}/2 using YouTubeTranscriptApi")
            transcript_list = YouTubeTranscriptApi.get_transcript(video_id, languages=languages)
            if not transcript_list:
                logger.warning(f"Empty transcript returned for video ID {video_id}")
                break
                
            # Extract text from transcript items
            transcript_text = " ".join([item['text'] for item in transcript_list])
            
            # Get video title
            video_title = f"YouTube Video {video_id}"
            try:
                yt = YouTube(f"https://www.youtube.com/watch?v={video_id}")
                if hasattr(yt, 'title') and yt.title:
                    video_title = yt.title
            except Exception as title_error:
                logger.warning(f"Could not get video title, using default: {str(title_error)}")
            
            logger.info(f"Successfully fetched transcript using YouTubeTranscriptApi for {video_id}")
            return transcript_text, video_title

        except (TranscriptsDisabled, NoTranscriptFound) as e:
            logger.warning(f"No transcript available via captions for {video_id}: {str(e)}")
            break
        except Exception as e:
            logger.warning(f"Error in YouTubeTranscriptApi attempt {attempt+1}: {str(e)}")
            if attempt < 1:
                time.sleep(2)  # Brief delay before retry

    # If we reach here, all methods failed
    logger.error(f"All transcription methods failed for {video_id}")
    raise Exception(f"Unable to transcribe this video: No transcript available")

def get_video_transcript(file_path):
    """
    Extract transcript from an uploaded video file (placeholder).

    Parameters:
        file_path (str): Path to the video file.

    Returns:
        str: Placeholder transcript text.

    Raises:
        Exception: If transcription fails.
    """
    try:
        logger.info(f"Processing video file: {file_path}")
        
        # Check if file exists
        if not os.path.exists(file_path):
            logger.error(f"File does not exist: {file_path}")
            raise FileNotFoundError(f"File not found: {file_path}")
            
        if not os.path.isfile(file_path):
            logger.error(f"Path is not a file: {file_path}")
            raise ValueError("Path is not a valid file")
            
        # Check file size
        file_size = os.path.getsize(file_path)
        logger.info(f"File size: {file_size / (1024*1024):.2f} MB")
        if file_size > 100 * 1024 * 1024:  # 100MB limit
            logger.error(f"File exceeds size limit: {file_size / (1024*1024):.2f} MB")
            raise ValueError("File exceeds the maximum size limit of 100MB")
            
        # Extract audio from video using ffmpeg (then normally pass it to STT)
        try:
            with tempfile.TemporaryDirectory() as temp_dir:
                audio_path = os.path.join(temp_dir, "audio.wav")
                
                logger.info(f"Extracting audio from video file to {audio_path}")
                cmd = [
                    "ffmpeg", 
                    "-i", file_path,
                    "-vn",  # No video
                    "-acodec", "pcm_s16le",  # PCM 16-bit audio
                    "-ar", "16000",  # 16kHz sample rate
                    "-ac", "1",      # Mono
                    "-y",            # Overwrite output file
                    audio_path
                ]
                
                process = subprocess.Popen(
                    cmd, 
                    stdout=subprocess.PIPE, 
                    stderr=subprocess.PIPE
                )
                stdout, stderr = process.communicate()
                
                if process.returncode != 0:
                    logger.error(f"FFmpeg failed: {stderr.decode()}")
                    raise Exception(f"Failed to extract audio: {stderr.decode()}")
                
                # Placeholder for transcript
                placeholder_transcript = (
                    "This is a placeholder transcript. In a real implementation, "
                    "a speech-to-text service would be used to transcribe the audio. "
                    "For the civic application, you may want to integrate a service like "
                    "Google Speech-to-Text, AWS Transcribe, or use a local model."
                )
                
                logger.info("Returning placeholder transcript")
                return placeholder_transcript
                
        except Exception as e:
            logger.error(f"Error processing audio: {str(e)}")
            raise Exception(f"Audio processing failed: {str(e)}")
            
    except Exception as e:
        logger.error(f"Error in video transcription: {str(e)}")
        error_message = str(e)
        if "ffmpeg" in error_message.lower():
            error_message = "Failed to process video file. Make sure ffmpeg is installed."
        raise Exception(f"Video transcription failed: {error_message}")