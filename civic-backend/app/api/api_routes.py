from flask import Blueprint

api = Blueprint('api', __name__)

# Import and register specific route modules
from app.api.video_routes import *
from app.api.analysis_routes import *
from app.api.search_routes import *
