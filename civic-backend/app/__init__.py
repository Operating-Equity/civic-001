from flask import Flask
from flask_cors import CORS
import os

def create_app():
    """Application factory function that creates and configures the Flask app."""
    # Create Flask app
    app = Flask(__name__)
    
    # Enable CORS
    CORS(app)
    
    # Load configuration
    from app.config import Config
    app.config.from_object(Config)
    
    # Ensure upload directory exists
    os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)
    
    # Register blueprints
    from app.api.api_routes import api
    app.register_blueprint(api, url_prefix='/api')
    
    # Add health check route
    @app.route('/health')
    def health_check():
        return {'status': 'ok'}, 200
    
    return app