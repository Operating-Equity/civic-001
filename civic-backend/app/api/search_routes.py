from flask import request, jsonify
from app.api.api_routes import api
from app.services.search_service import search_evidence, generate_keywords, search_evidence_batch

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

@api.route('/search/keywords/batch', methods=['POST'])
def generate_search_keywords_batch():
    """Generate search keywords for multiple claims in parallel"""
    if not request.json or 'claims' not in request.json:
        return jsonify({'error': 'No claims provided'}), 400
        
    claims = request.json.get('claims')
    video_title = request.json.get('video_title', '')
    
    if not isinstance(claims, list):
        return jsonify({'error': 'Claims must be provided as a list'}), 400
    
    try:
        # Process each claim to generate keywords
        results = []
        
        for claim_data in claims:
            if not isinstance(claim_data, dict):
                continue
                
            claim = claim_data.get('claim')
            context = claim_data.get('context', '')
            validation_info = claim_data.get('validationPotential', '')
            claim_id = claim_data.get('id', '')
            
            if not claim:
                continue
            
            keywords = generate_keywords(claim, context, validation_info, video_title)
            
            results.append({
                'id': claim_id,
                'claim': claim,
                'searchQueries': keywords
            })
        
        return jsonify({'results': results})
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

@api.route('/search/evidence/batch', methods=['POST'])
def search_for_evidence_batch():
    """Search for evidence across multiple queries in parallel"""
    if not request.json or 'queries' not in request.json:
        return jsonify({'error': 'No search queries provided'}), 400
        
    queries = request.json.get('queries')
    
    if not isinstance(queries, list):
        return jsonify({'error': 'Queries must be provided as a list'}), 400
    
    try:
        # Process queries in parallel
        results = search_evidence_batch(queries)
        return jsonify({'results': results})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@api.route('/search/evidence/for-claim', methods=['POST'])
def search_for_evidence_for_claim():
    """Generate keywords and search for evidence for a specific claim"""
    if not request.json or 'claim' not in request.json:
        return jsonify({'error': 'No claim provided'}), 400
        
    claim = request.json.get('claim')
    context = request.json.get('context', '')
    validation_info = request.json.get('validation_potential', '')
    video_title = request.json.get('video_title', '')
    
    try:
        # First generate keywords
        keywords = generate_keywords(claim, context, validation_info, video_title)
        
        # Then search for evidence in parallel
        search_results = search_evidence_batch(keywords)
        
        # Format results
        keyword_results = []
        for i, query in enumerate(keywords):
            keyword_results.append({
                'keyword': query,
                'results': search_results[i] if i < len(search_results) else []
            })
        
        return jsonify({
            'claim': claim,
            'keywordResults': keyword_results
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@api.route('/search/evidence/for-claims', methods=['POST'])
def search_for_evidence_for_claims():
    """Generate keywords and search for evidence for multiple claims"""
    if not request.json or 'claims' not in request.json:
        return jsonify({'error': 'No claims provided'}), 400
        
    claims = request.json.get('claims')
    video_title = request.json.get('video_title', '')
    
    if not isinstance(claims, list):
        return jsonify({'error': 'Claims must be provided as a list'}), 400
    
    try:
        all_results = []
        
        for claim_data in claims:
            if not isinstance(claim_data, dict):
                continue
                
            claim = claim_data.get('claim')
            context = claim_data.get('context', '')
            validation_info = claim_data.get('validationPotential', '')
            
            if not claim:
                continue
            
            # Generate keywords
            keywords = generate_keywords(claim, context, validation_info, video_title)
            
            # Search for evidence in parallel
            search_results = search_evidence_batch(keywords)
            
            # Format results
            keyword_results = []
            for i, query in enumerate(keywords):
                keyword_results.append({
                    'keyword': query,
                    'results': search_results[i] if i < len(search_results) else []
                })
            
            all_results.append({
                'claim': claim,
                'keywordResults': keyword_results
            })
        
        return jsonify({'results': all_results})
    except Exception as e:
        return jsonify({'error': str(e)}), 500