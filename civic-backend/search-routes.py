from flask import request, jsonify
from app.api.routes import api
from app.services.search_service import search_evidence, generate_keywords

@api.route('/search/keywords', methods=['POST'])
def generate_search_keywords():
    """Generate search keywords for a claim"""
    if not request.json or 'claim' not in request.json:
        return jsonify({'error': 'No claim provided'}), 400
        
    claim = request.json.get('claim')
    context = request.json.get('context', '')
    validation_info = request.json.get('validation_potential', '')
    video_title = request.json.get('video_title', '')
    
    try:
        keywords = generate_keywords(claim, context, validation_info, video_title)
        return jsonify({'keywords': keywords})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@api.route('/search/evidence', methods=['POST'])
def search_for_evidence():
    """Search for evidence related to keywords"""
    if not request.json or 'query' not in request.json:
        return jsonify({'error': 'No search query provided'}), 400
        
    query = request.json.get('query')
    
    try:
        results = search_evidence(query)
        return jsonify({'results': results})
    except Exception as e:
        return jsonify({'error': str(e)}), 500
