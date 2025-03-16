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
    """Validates if the video ID has the correct format (typically 11+ characters)"""
    return video_id and isinstance(video_id, str) and len(video_id) >= 11

def extract_video_id(url):
    """Extract YouTube video ID from URL"""
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
        
        # Get video title (we'll need to use a fallback since RapidAPI doesn't provide it)
        video_title = f"YouTube Video {video_id}"
        
        # Try to get a better title using pytube (without downloading)
        try:
            yt = YouTube(f"https://www.youtube.com/watch?v={video_id}")
            if yt.title:
                video_title = yt.title
                logger.info(f"Retrieved video title: {video_title}")
        except Exception as title_error:
            logger.warning(f"Could not get video title, using default: {str(title_error)}")
        
        logger.info(f"Successfully retrieved transcript via RapidAPI for video ID: {video_id}")
        
        return transcript_text, video_title
        
    except Exception as e:
        logger.error(f"Error fetching transcript from RapidAPI: {str(e)}")
        raise Exception(f"RapidAPI transcript fetching failed: {str(e)}")

def identify_speakers_from_text(transcript, num_speakers=None):
    """
    Simple text-based speaker identification when no audio analysis is available.
    Creates placeholder speaker data based on paragraph breaks.
    
    Args:
        transcript (str): The transcript text
        num_speakers (int): Optional number of speakers to identify
        
    Returns:
        dict: Dictionary containing speakers and segmented transcript
    """
    # Split transcript into paragraphs (potential speaker changes)
    paragraphs = re.split(r'\n\n|\.\s+', transcript)
    paragraphs = [p.strip() for p in paragraphs if len(p.strip()) > 20]
    
    if len(paragraphs) < 3:
        logger.warning("Transcript too short for reliable text-based speaker identification")
        return None
    
    # Default to 2 speakers if not specified
    if num_speakers is None:
        num_speakers = min(max(2, len(paragraphs) // 10), 5)
    
    # Create simple alternating speaker pattern (this is just a placeholder)
    speakers = {}
    segments = []
    
    for i, paragraph in enumerate(paragraphs):
        # Alternate speakers in a round-robin fashion
        speaker_id = f"speaker_{i % num_speakers}"
        speaker_name = f"Speaker {chr(65 + (i % num_speakers))}"  # A, B, C, etc.
        
        # Add to speakers dict if not already present
        if speaker_id not in speakers:
            speakers[speaker_id] = speaker_name
        
        # Create segment with estimated timing
        # We're creating fake timestamps since we don't have actual timing data
        duration = max(3, len(paragraph.split()) * 0.4)  # Rough estimate based on word count
        start = segments[-1]['end'] if segments else 0
        end = start + duration
        
        segments.append({
            'speaker': speaker_id,
            'start': start,
            'end': end,
            'text': paragraph
        })
    
    logger.info(f"Created placeholder speaker identification with {num_speakers} speakers")
    return {
        "speakers": speakers,
        "segments": segments,
        "method": "text-based"  # Flag that this is estimated, not from audio analysis
    }

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
        logger.error(f"Error downloading audio from YouTube: {str(e)}")
        raise Exception(f"Cannot download audio: YouTube is restricting access to this video")

def get_youtube_transcript(video_id, languages=['en'], with_speakers=False):
    """
    Fetch transcript from a YouTube video using two primary methods:
    1. RapidAPI (primary method)
    2. YouTubeTranscriptApi (fallback method)
    
    Parameters:
        video_id (str): The YouTube video ID.
        languages (list): A list of language codes to try for the transcript (default is ['en']).
        with_speakers (bool): Whether to attempt basic speaker identification

    Returns:
        tuple: (transcript_text, video_title) or (transcript_text, video_title, speakers_data)
               if with_speakers=True

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
        
        # If speaker identification is requested, use text-based approach
        if with_speakers:
            try:
                logger.info("Speaker identification requested, using text-based approach")
                speakers_data = identify_speakers_from_text(transcript_text)
                if speakers_data:
                    return transcript_text, video_title, speakers_data
            except Exception as e:
                logger.error(f"Speaker identification failed: {str(e)}")
        
        # Return without speaker data if not requested or if identification failed
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

            # If speaker identification is requested, use text-based approach
            if with_speakers:
                try:
                    logger.info("Speaker identification requested, using text-based approach")
                    speakers_data = identify_speakers_from_text(transcript_text)
                    if speakers_data:
                        return transcript_text, video_title, speakers_data
                except Exception as e:
                    logger.error(f"Speaker identification failed: {str(e)}")
            
            # Return without speaker data if not requested or if identification failed
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
    
    # Method 2: Try using youtube-dl if available
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
    
    # Method 3: Try using a simple HTTP request to get title from HTML
    try:
        import requests
        import re
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.212 Safari/537.36'
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
    
def get_video_transcript(file_path, with_speakers=False):
    """
    Extract transcript from an uploaded video file.
    
    Parameters:
        file_path (str): Path to the video file.
        with_speakers (bool): Whether to attempt speaker identification

    Returns:
        dict or str: If with_speakers is True, returns a dict containing the transcript and speaker data.
                     Otherwise, returns just the transcript text.

    Raises:
        Exception: If transcription fails.
    """
    try:
        logger.info(f"Processing video file: {file_path}, with speakers: {with_speakers}")
        
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
        if file_size > 100 * 1024 * 1024:  # 100MB
            logger.error(f"File exceeds size limit: {file_size / (1024*1024):.2f} MB")
            raise ValueError("File exceeds the maximum size limit of 100MB")
            
        # Extract audio from video using ffmpeg
        try:
            # Create a temporary directory for the audio file
            with tempfile.TemporaryDirectory() as temp_dir:
                audio_path = os.path.join(temp_dir, "audio.wav")
                
                # Run ffmpeg to extract audio
                logger.info(f"Extracting audio from video file to {audio_path}")
                cmd = [
                    "ffmpeg", 
                    "-i", file_path,
                    "-vn",  # No video
                    "-acodec", "pcm_s16le",  # PCM 16-bit audio
                    "-ar", "16000",  # 16kHz sample rate
                    "-ac", "1",  # Mono
                    "-y",  # Overwrite output file
                    audio_path
                ]
                
                # Execute ffmpeg command
                process = subprocess.Popen(
                    cmd, 
                    stdout=subprocess.PIPE, 
                    stderr=subprocess.PIPE
                )
                stdout, stderr = process.communicate()
                
                if process.returncode != 0:
                    logger.error(f"FFmpeg failed: {stderr.decode()}")
                    raise Exception(f"Failed to extract audio: {stderr.decode()}")
                
                # In a real implementation, we would use a speech recognition service here
                # For simplicity, we'll create a placeholder transcript
                
                # Placeholder for transcript
                placeholder_transcript = (
                    "This is a placeholder transcript. In a real implementation, "
                    "a speech-to-text service would be used to transcribe the audio. "
                    "For the civic application, you may want to integrate a service like "
                    "Google Speech-to-Text, AWS Transcribe, or use a local model."
                )
                
                # If speaker identification is requested, create placeholder speaker data
                if with_speakers:
                    speakers_data = {
                        "speakers": {
                            "speaker_0": "Speaker A",
                            "speaker_1": "Speaker B"
                        },
                        "segments": [
                            {
                                "speaker": "speaker_0",
                                "start": 0,
                                "end": 10,
                                "text": "This is a placeholder segment from Speaker A."
                            },
                            {
                                "speaker": "speaker_1",
                                "start": 11,
                                "end": 20,
                                "text": "This is a placeholder segment from Speaker B."
                            }
                        ],
                        "method": "placeholder"
                    }
                    
                    logger.info("Returning placeholder transcript with speaker data")
                    return {
                        "transcript": placeholder_transcript,
                        "speakers_data": speakers_data
                    }
                
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