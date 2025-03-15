from flask import request, jsonify, current_app
from app.api.api_routes import api
from app import create_app
from app.services.claim_analysis import identify_claims, generate_summary
from app.services.openai_service import evaluate_with_openai
from app.services.anthropic_service import evaluate_with_anthropic
from app.services.perplexity_service import evaluate_with_perplexity
import concurrent.futures
from threading import Thread
import traceback

@api.route('/analysis/claims', methods=['POST'])
def extract_claims():
    """Extract empirical claims from a transcript"""
    if not request.json or 'transcript' not in request.json:
        return jsonify({'error': 'No transcript provided'}), 400
        
    transcript = request.json.get('transcript')
    video_title = request.json.get('video_title', '')
    speakers_data = request.json.get('speakers_data', {})
    
    try:
        claims = identify_claims(transcript, video_title, speakers_data)
        return jsonify({'claims': claims})
    except Exception as e:
        print(f"Error extracting claims: {str(e)}\n{traceback.format_exc()}")
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
    """Evaluate a single claim or multiple claims using multiple AI providers in parallel"""
    # Log that the endpoint was called
    print(f"[EVALUATE] Endpoint called with request data: {request.json}")
    
    # Check if we're processing a single claim or multiple claims
    if 'claims' in request.json:
        return evaluate_multiple_claims()
    elif 'claim' in request.json:
        return evaluate_single_claim()
    else:
        print("[EVALUATE] Error: Neither claim nor claims provided in request")
        return jsonify({'error': 'No claim or claims provided'}), 400

def evaluate_single_claim():
    """Evaluate a single claim using multiple AI providers in parallel"""
    claim = request.json.get('claim')
    context = request.json.get('context', '')
    model = request.json.get('model', 'all')
    
    print(f"[EVALUATE] Processing single claim: '{claim[:50]}...' with model: {model}")
    
    try:
        # Determine which models to evaluate
        models_to_evaluate = []
        if model == 'all':
            models_to_evaluate = ['perplexity', 'openai', 'anthropic']
        else:
            models_to_evaluate = [model]
        
        # Store the current application for use in threads
        app = current_app._get_current_object()
        results = run_parallel_evaluation(app, claim, context, models_to_evaluate)
            
        print(f"[EVALUATE] Returning results with {len(results)} model evaluations")
        return jsonify(results)
    except Exception as e:
        error_message = f"Error evaluating claim: {str(e)}"
        print(f"[EVALUATE] {error_message}")
        return jsonify({'error': error_message}), 500

def evaluate_multiple_claims():
    """Evaluate multiple claims in parallel using multiple AI providers"""
    claims = request.json.get('claims', [])
    context = request.json.get('context', '')
    model = request.json.get('model', 'all')
    
    if not claims or not isinstance(claims, list):
        return jsonify({'error': 'Invalid claims format. Expected a list of claims.'}), 400
    
    print(f"[EVALUATE] Processing {len(claims)} claims in parallel with model: {model}")
    
    try:
        # Determine which models to evaluate
        models_to_evaluate = []
        if model == 'all':
            models_to_evaluate = ['perplexity', 'openai', 'anthropic']
        else:
            models_to_evaluate = [model]
        
        # Store the current application for use in threads
        app = current_app._get_current_object()
        
        # Process all claims in parallel using a ThreadPoolExecutor
        all_results = {}
        with concurrent.futures.ThreadPoolExecutor(max_workers=min(len(claims), 10)) as executor:
            # Create a dictionary to track futures for each claim
            future_to_claim = {}
            
            # Submit all claims for processing
            for i, claim_data in enumerate(claims):
                claim_text = claim_data.get('claim')
                claim_id = claim_data.get('id', f"claim_{i}")
                claim_context = claim_data.get('context', '') 
                
                # Combine global context with claim-specific context
                combined_context = f"{context}\n\nClaim Context:\n{claim_context}" if claim_context else context
                
                future = executor.submit(
                    run_parallel_evaluation,
                    app, 
                    claim_text,
                    combined_context,
                    models_to_evaluate,
                    claim_id
                )
                future_to_claim[future] = claim_id
            
            # Process results as they complete
            for future in concurrent.futures.as_completed(future_to_claim):
                claim_id = future_to_claim[future]
                try:
                    claim_results = future.result()
                    all_results[claim_id] = claim_results
                except Exception as exc:
                    print(f"[EVALUATE] Claim {claim_id} generated an exception: {exc}")
                    all_results[claim_id] = {
                        "error": str(exc),
                        "perplexity": create_error_result(claims[int(claim_id.split('_')[1]) if claim_id.startswith('claim_') else 0].get('claim'), "perplexity", str(exc)),
                        "openai": create_error_result(claims[int(claim_id.split('_')[1]) if claim_id.startswith('claim_') else 0].get('claim'), "openai", str(exc)),
                        "anthropic": create_error_result(claims[int(claim_id.split('_')[1]) if claim_id.startswith('claim_') else 0].get('claim'), "anthropic", str(exc))
                    }
        
        print(f"[EVALUATE] Returning results for {len(all_results)} claims with parallel evaluation")
        return jsonify(all_results)
    except Exception as e:
        error_message = f"Error evaluating multiple claims: {str(e)}"
        print(f"[EVALUATE] {error_message}")
        return jsonify({'error': error_message}), 500

def run_parallel_evaluation(app, claim, context, models_to_evaluate, claim_id=None):
    """Run evaluation for a single claim across multiple models in parallel"""
    results = {}
    
    # Define a function to process a single model
    def process_model(model_name):
        # Establish application context for this thread
        with app.app_context():
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
                
                # Add the claim ID to the result if provided
                if claim_id:
                    result["claimId"] = claim_id
                    
                return model_name, result
            except Exception as model_error:
                print(f"[EVALUATE] {model_name.capitalize()} evaluation failed: {str(model_error)}")
                error_result = create_error_result(claim, model_name, str(model_error))
                return model_name, error_result
    
    # Process all models in parallel using ThreadPoolExecutor
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(models_to_evaluate)) as executor:
        # Submit all tasks
        future_to_model = {executor.submit(process_model, model_name): model_name for model_name in models_to_evaluate}
        
        # Process results as they complete with a timeout
        timeout_per_model = 30  # 30 seconds per model
        
        try:
            for future in concurrent.futures.as_completed(future_to_model, timeout=timeout_per_model * len(models_to_evaluate)):
                model_name = future_to_model[future]
                try:
                    model_result = future.result(timeout=timeout_per_model)
                    if model_result:
                        result_model_name, result = model_result
                        if result_model_name and result:
                            results[result_model_name] = result
                except concurrent.futures.TimeoutError:
                    print(f"[EVALUATE] Timeout for model: {model_name}")
                    results[model_name] = create_error_result(
                        claim, model_name, f"Evaluation timed out after {timeout_per_model} seconds"
                    )
                except Exception as e:
                    print(f"[EVALUATE] Error processing result for {model_name}: {str(e)}")
                    results[model_name] = create_error_result(
                        claim, model_name, f"Error: {str(e)}"
                    )
        except concurrent.futures.TimeoutError:
            print(f"[EVALUATE] Overall evaluation timed out")
            # For any models that didn't complete, add timeout results
            for model_name in models_to_evaluate:
                if model_name not in results:
                    results[model_name] = create_error_result(
                        claim, model_name, "Evaluation timed out"
                    )
    
    # Ensure we always return results for all requested models
    for model_name in models_to_evaluate:
        if model_name not in results:
            results[model_name] = create_error_result(
                claim, model_name, "Evaluation failed to complete"
            )
    
    return results

def create_error_result(claim, model_name, error_message):
    """Create a standardized error result for a failed model evaluation"""
    return {
        "statement": claim,
        "classification": "UNVERIFIED",
        "confidence": 0,
        "supportingFacts": f"Error: {error_message}",
        "model": model_name.capitalize()
    }