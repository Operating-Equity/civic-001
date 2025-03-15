import assemblyai as aai
import time
import logging
import os
from flask import current_app

# Set up logging
logger = logging.getLogger(__name__)

def get_youtube_transcript_via_assemblyai(video_id, with_speakers=False):
    """
    Process a YouTube video using AssemblyAI's direct YouTube integration.
    This bypasses YouTube IP blocking completely.
    
    Args:
        video_id (str): YouTube video ID
        with_speakers (bool): Whether to identify speakers
        
    Returns:
        tuple: (transcript_text, video_title) or (transcript_text, video_title, speakers_data)
    """
    # Get API key from environment
    assembly_ai_key = current_app.config.get('ASSEMBLY_AI_KEY')
    
    if not assembly_ai_key:
        logger.error("ASSEMBLY_AI_KEY is not configured")
        raise Exception("AssemblyAI API key not configured. Please add ASSEMBLY_AI_KEY to your environment variables.")
    
    # Set the API key
    aai.settings.api_key = assembly_ai_key
    
    try:
        # Create YouTube video URL from ID
        youtube_url = f"https://www.youtube.com/watch?v={video_id}"
        
        logger.info(f"Submitting YouTube URL to AssemblyAI: {youtube_url}")
        
        # Configure transcription options
        config = aai.TranscriptionConfig(
            speaker_labels=with_speakers,         # Enable speaker identification if requested
            language_detection=True,              # Auto-detect language
            punctuate=True,                       # Add punctuation
            format_text=True,                     # Clean up text
            content_safety=False,                 # Disable content safety to save time
            auto_highlights=True,                 # Get key phrases
            entity_detection=True                 # Identify entities
        )
        
        # Create transcriber
        transcriber = aai.Transcriber()
        
        # Submit YouTube URL directly - AssemblyAI handles downloading
        logger.info("Starting AssemblyAI transcription")
        transcript = transcriber.transcribe(youtube_url, config)
        
        if not transcript or not hasattr(transcript, 'text') or not transcript.text:
            logger.error("AssemblyAI returned empty transcript")
            raise Exception("Transcription resulted in empty text")
        
        # Get video title 
        video_title = f"YouTube Video {video_id}"
        try:
            # If highlights are available, use the first one as a fallback title
            if hasattr(transcript, 'auto_highlights') and transcript.auto_highlights:
                video_title = transcript.auto_highlights.results[0].text
        except Exception as e:
            logger.warning(f"Could not extract video title: {str(e)}")
        
        # Format transcript text
        transcript_text = transcript.text
        
        # Extract speaker data if requested
        speakers_data = None
        if with_speakers and hasattr(transcript, 'utterances') and transcript.utterances:
            speakers = {}
            segments = []
            
            # Process utterances to get speaker segments
            for utterance in transcript.utterances:
                speaker_id = utterance.speaker
                
                # Add speaker if it's new
                if speaker_id not in speakers:
                    speakers[speaker_id] = f"Speaker {chr(65 + len(speakers))}"  # A, B, C, etc.
                
                # Add segment
                segments.append({
                    "speaker": speaker_id,
                    "start": utterance.start / 1000,  # Convert from ms to seconds
                    "end": utterance.end / 1000,      # Convert from ms to seconds
                    "text": utterance.text
                })
            
            speakers_data = {
                "speakers": speakers,
                "segments": segments
            }
        
        logger.info(f"Successfully transcribed YouTube video {video_id} using AssemblyAI")
        
        # Return appropriate response based on whether speakers were requested
        if with_speakers and speakers_data:
            return transcript_text, video_title, speakers_data
        else:
            return transcript_text, video_title
            
    except Exception as e:
        logger.error(f"AssemblyAI transcription failed: {str(e)}")
        raise Exception(f"AssemblyAI YouTube transcription failed: {str(e)}")
