import os
import uuid
import time
import logging
import traceback
from flask import request, jsonify, current_app
from werkzeug.utils import secure_filename
from werkzeug.exceptions import RequestEntityTooLarge
from app.api.api_routes import api
from app.services.video_service import process_video_file, extract_video_id
from app.services.transcript_service import get_youtube_transcript, get_video_transcript

# Set up logging
logger = logging.getLogger(__name__)

@api.route('/video/process', methods=['POST'])
def process_video():
    """
    Process a video from a YouTube URL or uploaded file.
    Returns transcript, claims, and summary.
    """
    try:
        # Check for YouTube URL in request
        if request.is_json and 'video_url' in request.json:
            # Extract with_speakers parameter from request
            with_speakers = request.json.get('with_speakers', False)
            logger.info(f"Processing YouTube URL with speaker identification: {with_speakers}")
            return process_youtube_video(request.json.get('video_url'), with_speakers)
        # Check for file upload in request
        elif request.files and 'video_file' in request.files:
            # Extract with_speakers parameter from form data
            with_speakers = request.form.get('with_speakers', 'false').lower() == 'true'
            logger.info(f"Processing uploaded video with speaker identification: {with_speakers}")
            return process_uploaded_video(request.files['video_file'], with_speakers)
        else:
            logger.warning("Invalid request: No video URL or file provided")
            return jsonify({'error': 'No video URL or file provided'}), 400
    
    except RequestEntityTooLarge:
        logger.error("Request entity too large: File exceeds size limit")
        return jsonify({'error': 'File exceeds the maximum size limit (100MB)'}), 413
        
    except Exception as e:
        logger.error(f"Unexpected error in process_video: {str(e)}\n{traceback.format_exc()}")
        return jsonify({'error': 'An unexpected error occurred while processing your request'}), 500

def process_youtube_video(video_url, with_speakers=False):
    """Handle YouTube video URL processing with speaker identification"""
    start_time = time.time()
    logger.info(f"Processing YouTube URL: {video_url}, with speakers: {with_speakers}")
    
    try:
        # Extract video ID (with validation)
        video_id = extract_video_id(video_url)
        if not video_id:
            logger.warning(f"Invalid YouTube URL format: {video_url}")
            return jsonify({'error': 'Invalid YouTube URL format. Please provide a valid YouTube video URL.'}), 400
        
        # Log the video ID for debugging
        logger.info(f"Extracted video ID: {video_id}")
        
        # Get video transcript with timeout handling
        try:
            logger.info(f"Fetching transcript for video ID: {video_id}, with speakers: {with_speakers}")
            
            # Initialize speakers_data as None
            speakers_data = None
            transcript = None
            video_title = None
            
            # Try to get transcript with speaker identification if requested
            if with_speakers:
                try:
                    result = get_youtube_transcript(video_id, with_speakers=True)
                    # Properly handle both return formats
                    if isinstance(result, tuple):
                        if len(result) == 3:
                            transcript, video_title, speakers_data = result
                        elif len(result) == 2:
                            transcript, video_title = result
                except Exception as speaker_error:
                    # If speaker identification fails, log error and fall back to regular transcript
                    logger.error(f"Speaker identification failed, falling back to standard transcript: {str(speaker_error)}")
                    transcript, video_title = get_youtube_transcript(video_id, with_speakers=False)
            else:
                # Standard transcript without speaker identification
                transcript, video_title = get_youtube_transcript(video_id, with_speakers=False)
            
            # Check if transcript is valid
            if not transcript or not isinstance(transcript, str) or not transcript.strip():
                logger.error(f"Empty transcript returned for video ID: {video_id}")
                return jsonify({'error': 'Could not extract transcript from this video. It may not have captions available.'}), 422
            
            # Generate thumbnail URL
            thumbnail_url = f"https://img.youtube.com/vi/{video_id}/maxresdefault.jpg"
            
            # Return result with available data
            processing_time = time.time() - start_time
            logger.info(f"YouTube video processed successfully in {processing_time:.2f}s: {video_id}")
            
            # Include speakers_data in the response if available
            response_data = {
                'transcript': transcript,
                'video_title': video_title or f"YouTube Video {video_id}",  # Ensure we have a title
                'thumbnail_url': thumbnail_url
            }
            
            # Only add speakers_data if it's not None
            if with_speakers and speakers_data is not None:
                response_data['speakers_data'] = speakers_data
                logger.info(f"Returning speaker data with {len(speakers_data.get('segments', []))} segments")
            elif with_speakers:
                logger.info("Speaker identification was requested but no speaker data was obtained")
            
            return jsonify(response_data)
            
        except ValueError as e:
            # Handle validation errors
            logger.warning(f"Validation error processing YouTube video: {str(e)}")
            return jsonify({'error': str(e)}), 400
            
        except Exception as e:
            # Handle service errors with more specific message
            logger.error(f"Failed to process YouTube video {video_id}: {str(e)}\n{traceback.format_exc()}")
            error_message = "Failed to process YouTube video. "
            
            if "No transcript" in str(e) or "transcript" in str(e).lower():
                error_message += "The video may not have captions available."
            else:
                error_message += "Please try again or use a different video."
                
            return jsonify({'error': error_message}), 422
            
    except Exception as e:
        logger.error(f"Unexpected error processing YouTube URL: {str(e)}\n{traceback.format_exc()}")
        return jsonify({'error': 'Failed to process YouTube video. Please try again later.'}), 500
    
def process_uploaded_video(video_file, with_speakers=False):
    """Handle uploaded video file processing with speaker identification"""
    start_time = time.time()
    
    if video_file.filename == '':
        logger.warning("Empty filename in uploaded file")
        return jsonify({'error': 'No selected file'}), 400
    
    if not allowed_file(video_file.filename):
        logger.warning(f"File type not allowed: {video_file.filename}")
        return jsonify({'error': f'File type not allowed. Supported formats: {", ".join(current_app.config["ALLOWED_EXTENSIONS"])}'}), 415
    
    try:
        # Log file information
        logger.info(f"Processing uploaded file: {video_file.filename}, with speakers: {with_speakers}")
        
        # Create unique filename to avoid collisions
        filename = secure_filename(f"{uuid.uuid4()}_{video_file.filename}")
        filepath = os.path.join(current_app.config['UPLOAD_FOLDER'], filename)
        
        # Make sure upload directory exists
        try:
            os.makedirs(current_app.config['UPLOAD_FOLDER'], exist_ok=True)
        except OSError as e:
            logger.error(f"Failed to create upload directory: {str(e)}")
            return jsonify({'error': 'Server configuration error'}), 500
        
        # Save file with error handling
        try:
            video_file.save(filepath)
            logger.info(f"File saved successfully: {filepath}")
        except Exception as e:
            logger.error(f"Failed to save uploaded file: {str(e)}")
            return jsonify({'error': 'Failed to save uploaded file'}), 500
        
        try:
            # Initialize speakers_data as None
            speakers_data = None
            
            # Process video file to extract transcript, now with speaker identification
            logger.info(f"Extracting transcript from file: {filepath}, with speakers: {with_speakers}")
            
            # Call the transcript service with speaker identification if requested
            if with_speakers:
                try:
                    transcript_result = get_video_transcript(filepath, with_speakers=True)
                    transcript = transcript_result.get('transcript', '')
                    speakers_data = transcript_result.get('speakers_data')
                except Exception as speaker_error:
                    # If speaker identification fails, fall back to regular transcript
                    logger.error(f"Speaker identification failed, falling back to standard transcript: {str(speaker_error)}")
                    transcript = get_video_transcript(filepath, with_speakers=False)
            else:
                transcript = get_video_transcript(filepath)
            
            # Check transcript validity
            if not transcript or not isinstance(transcript, str) or not transcript.strip():
                logger.error("Empty transcript returned from video file")
                return jsonify({'error': 'Failed to extract any speech from the video'}), 422
            
            # Return transcript data
            processing_time = time.time() - start_time
            logger.info(f"Video file processed successfully in {processing_time:.2f}s")
            
            # Prepare the response
            response_data = {
                'transcript': transcript,
                'video_title': 'Uploaded Video',
                'thumbnail_url': None
            }
            
            # Add speaker data if available
            if with_speakers and speakers_data is not None:
                response_data['speakers_data'] = speakers_data
                logger.info(f"Returning speaker data with {len(speakers_data.get('segments', []))} segments")
            elif with_speakers:
                logger.info("Speaker identification was requested but no speaker data was obtained")
            
            return jsonify(response_data)
            
        except Exception as e:
            logger.error(f"Failed to process video file: {str(e)}\n{traceback.format_exc()}")
            
            # Provide helpful error message based on exception type
            error_message = "Failed to process video file. "
            if "AssemblyAI" in str(e) and "key" in str(e).lower():
                error_message = "Transcription service configuration error. Please contact support."
            elif "timeout" in str(e).lower():
                error_message += "The processing timed out. Please try a shorter video."
            else:
                error_message += "Please ensure the video contains audio and is in a supported format."
                
            return jsonify({'error': error_message}), 422
            
        finally:
            # Clean up the file regardless of success/failure
            try:
                if os.path.exists(filepath):
                    os.remove(filepath)
                    logger.info(f"Temporary file removed: {filepath}")
            except Exception as e:
                logger.error(f"Failed to remove temporary file {filepath}: {str(e)}")
                
    except Exception as e:
        logger.error(f"Unexpected error processing uploaded video: {str(e)}\n{traceback.format_exc()}")
        return jsonify({'error': 'An unexpected error occurred while processing your video'}), 500
    
def allowed_file(filename):
    """Check if the file extension is allowed"""
    return '.' in filename and \
           filename.rsplit('.', 1)[1].lower() in current_app.config['ALLOWED_EXTENSIONS']