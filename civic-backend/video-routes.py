import os
import uuid
from flask import request, jsonify, current_app
from werkzeug.utils import secure_filename
from app.api.routes import api
from app.services.video_service import process_video_file, extract_video_id
from app.services.transcript_service import get_youtube_transcript, get_video_transcript

@api.route('/video/process', methods=['POST'])
def process_video():
    """
    Process a video from a YouTube URL or uploaded file.
    Returns transcript, claims, and summary.
    """
    if 'video_url' in request.json:
        # Process YouTube URL
        video_url = request.json.get('video_url')
        
        try:
            # Extract video ID
            video_id = extract_video_id(video_url)
            if not video_id:
                return jsonify({'error': 'Invalid YouTube URL format'}), 400
                
            # Get video transcript
            transcript, video_title = get_youtube_transcript(video_id)
            
            # Generate thumbnail URL
            thumbnail_url = f"https://img.youtube.com/vi/{video_id}/maxresdefault.jpg"
            
            # Return result with available data
            return jsonify({
                'transcript': transcript,
                'video_title': video_title,
                'thumbnail_url': thumbnail_url
            })
            
        except Exception as e:
            return jsonify({'error': str(e)}), 500
            
    elif 'video_file' in request.files:
        # Process uploaded video file
        video_file = request.files['video_file']
        
        if video_file.filename == '':
            return jsonify({'error': 'No selected file'}), 400
            
        if video_file and allowed_file(video_file.filename):
            try:
                # Create unique filename
                filename = secure_filename(f"{uuid.uuid4()}_{video_file.filename}")
                filepath = os.path.join(current_app.config['UPLOAD_FOLDER'], filename)
                
                # Save file temporarily
                os.makedirs(current_app.config['UPLOAD_FOLDER'], exist_ok=True)
                video_file.save(filepath)
                
                # Process video file to extract transcript
                transcript = get_video_transcript(filepath)
                
                # Clean up the file
                os.remove(filepath)
                
                # Return transcript
                return jsonify({
                    'transcript': transcript,
                    'video_title': 'Uploaded Video',
                    'thumbnail_url': None
                })
                
            except Exception as e:
                return jsonify({'error': str(e)}), 500
        else:
            return jsonify({'error': 'File type not allowed'}), 400
    else:
        return jsonify({'error': 'No video URL or file provided'}), 400

def allowed_file(filename):
    """Check if the file extension is allowed"""
    return '.' in filename and \
           filename.rsplit('.', 1)[1].lower() in current_app.config['ALLOWED_EXTENSIONS']
