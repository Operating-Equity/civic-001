from flask import request, jsonify
from app.api.api_routes import api
from app.services.claim_analysis import identify_claims, generate_summary
from app.services.openai_service import evaluate_with_openai
from app.services.anthropic_service import evaluate_with_anthropic
from app.services.perplexity_service import evaluate_with_perplexity
import concurrent.futures
from threading import Thread

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
    # Log that the endpoint was called
    print(f"[EVALUATE] Endpoint called with request data: {request.json}")
    
    if not request.json or 'claim' not in request.json:
        print("[EVALUATE] Error: No claim provided in request")
        return jsonify({'error': 'No claim provided'}), 400
        
    claim = request.json.get('claim')
    context = request.json.get('context', '')
    model = request.json.get('model', 'all')
    
    print(f"[EVALUATE] Processing claim: '{claim[:50]}...' with model: {model}")
    
    try:
        results = {}
        
        # Determine which models to evaluate
        models_to_evaluate = []
        if model == 'all':
            models_to_evaluate = ['perplexity', 'openai', 'anthropic']
        else:
            models_to_evaluate = [model]
        
        # Define a function to process a single model
        def process_model(model_name):
            try:
                if model_name == 'perplexity':
                    print(f"[EVALUATE] Calling Perplexity API for claim: '{claim[:30]}...'")
                    result = evaluate_with_perplexity(claim, context)
                    print("[EVALUATE] Perplexity evaluation successful")
                elif model_name == 'openai':
                    print(f"[EVALUATE] Calling OpenAI API for claim: '{claim[:30]}...'")
                    result = evaluate_with_openai(claim, context)
                    print("[EVALUATE] OpenAI evaluation successful")
                elif model_name == 'anthropic':
                    print(f"[EVALUATE] Calling Anthropic API for claim: '{claim[:30]}...'")
                    result = evaluate_with_anthropic(claim, context)
                    print("[EVALUATE] Anthropic evaluation successful")
                else:
                    return None, f"Unknown model: {model_name}"
                
                return model_name, result
            except Exception as model_error:
                print(f"[EVALUATE] {model_name.capitalize()} evaluation failed: {str(model_error)}")
                error_result = {
                    "statement": claim,
                    "classification": "UNVERIFIED",
                    "confidence": 0,
                    "supportingFacts": f"Error: {str(model_error)}",
                    "model": model_name.capitalize()
                }
                return model_name, error_result
        
        # Process models in parallel using ThreadPoolExecutor
        with concurrent.futures.ThreadPoolExecutor(max_workers=len(models_to_evaluate)) as executor:
            # Submit all tasks
            future_to_model = {
                executor.submit(process_model, model_name): model_name 
                for model_name in models_to_evaluate
            }
            
            # Process results as they complete
            for future in concurrent.futures.as_completed(future_to_model):
                model_name, result = future.result()
                if model_name and result:
                    results[model_name] = result
        
        print(f"[EVALUATE] Returning results with {len(results)} model evaluations")
        return jsonify(results)
    except Exception as e:
        error_message = f"Error evaluating claim: {str(e)}"
        print(f"[EVALUATE] {error_message}")
        return jsonify({'error': error_message}), 500
