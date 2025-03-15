import os
from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv()

class Config:
    # Flask configuration
    SECRET_KEY = os.environ.get('SECRET_KEY') or 'dev-key-for-civic-app'
    DEBUG = os.environ.get('FLASK_DEBUG') == '1'
    
    # API Keys
    OPENAI_API_KEY = os.environ.get('OPENAI_API_KEY')
    PERPLEXITY_API_KEY = os.environ.get('PERPLEXITY_API_KEY')
    ANTHROPIC_API_KEY = os.environ.get('ANTHROPIC_API_KEY')
    EXA_API_KEY = os.environ.get('EXA_API_KEY')
    ASSEMBLY_AI_KEY = os.environ.get('ASSEMBLY_AI_KEY')
    RAPIDAPI_KEY = os.environ.get('RAPIDAPI_KEY')
    
    # File upload settings
    UPLOAD_FOLDER = os.path.join(os.getcwd(), 'uploads')
    MAX_CONTENT_LENGTH = 100 * 1024 * 1024  # 100MB max upload
    ALLOWED_EXTENSIONS = {'mp4', 'avi', 'mov', 'wmv', 'flv', 'mkv'}
