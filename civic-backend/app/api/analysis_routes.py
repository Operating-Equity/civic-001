from flask import request, jsonify
from app.api.routes import api
from app.services.claim_analysis import identify_claims, generate_summary
from app.services.openai_service import evaluate_with_openai
from app.services.anthropic_service import evaluate_with_anthropic
from app.services.perplexity_service import evaluate_with_perplexity

@api.route('/analysis/claims', methods=['POST'])
def extract_claims():
    """Extract empirical claims from a transcript"""
    if not request.json or 'transcript' not in request.json:
        return jsonify({'error': 'No transcript provided'}), 400
        
    transcript = request.json.get('transcript')
    
    try:
        claims = identify_claims(transcript)
        return jsonify({'claims': claims})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@api.route('/analysis/summary', methods=['POST'])
def create_summary():
    """Generate a summary from a transcript"""
    if not request.json or 'transcript' not in request.json:
        return jsonify({'error': 'No transcript provided'}), 400
        
    transcript = request.json.get('transcript')
    
    try:
        summary = generate_summary(transcript)
        return jsonify({'summary': summary})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@api.route('/analysis/evaluate', methods=['POST'])
def evaluate_claim():
    """Evaluate a claim using multiple AI providers"""
    if not request.json or 'claim' not in request.json:
        return jsonify({'error': 'No claim provided'}), 400
        
    claim = request.json.get('claim')
    context = request.json.get('context', '')
    model = request.json.get('model', 'all')
    
    try:
        results = {}
        
        # Evaluate with specified model or all models
        if model in ['all', 'perplexity']:
            results['perplexity'] = evaluate_with_perplexity(claim, context)
            
        if model in ['all', 'openai']:
            results['openai'] = evaluate_with_openai(claim, context)
            
        if model in ['all', 'anthropic']:
            results['anthropic'] = evaluate_with_anthropic(claim, context)
            
        return jsonify(results)
    except Exception as e:
        return jsonify({'error': str(e)}), 500
