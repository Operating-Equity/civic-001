from flask import request, jsonify, current_app
from app.api.api_routes import api
from app import create_app
from app.services.claim_analysis import identify_claims, generate_summary
from app.services.openai_service import evaluate_with_openai
from app.services.perplexity_service import evaluate_with_perplexity
from app.utils.cache import response_cache
import concurrent.futures
from threading import Thread
import traceback
import logging
import time

# Set up logging
logger = logging.getLogger(__name__)

@api.route('/analysis/summary', methods=['POST'])
def generate_summary_route():
    """Generate a summary of the transcript"""
    if not request.json or 'transcript' not in request.json:
        return jsonify({'error': 'No transcript provided'}), 400
    
    transcript = request.json.get('transcript')
    video_title = request.json.get('video_title', '')
    
    try:
        summary = generate_summary(transcript, video_title)
        return jsonify({'summary': summary})
    except Exception as e:
        logger.error(f"Error generating summary: {str(e)}")
        return jsonify({'error': str(e)}), 500

@api.route('/analysis/claims', methods=['POST'])
def extract_claims_route():
    """Extract empirical claims from a transcript"""
    if not request.json or 'transcript' not in request.json:
        return jsonify({'error': 'No transcript provided'}), 400
    
    transcript = request.json.get('transcript')
    video_title = request.json.get('video_title', '')
    speakers_data = request.json.get('speakers_data')
    
    try:
        claims = identify_claims(transcript, video_title, speakers_data)
        return jsonify({'claims': claims})
    except Exception as e:
        logger.error(f"Error extracting claims: {str(e)}")
        return jsonify({'error': str(e)}), 500
    
    
@api.route('/analysis/evaluate', methods=['POST'])
def evaluate_claim():
    """Evaluate a single claim or multiple claims using multiple AI providers in parallel"""
    # Log that the endpoint was called
    logger.info(f"[EVALUATE] Endpoint called with request data: {request.json}")
    
    # Check if we're processing a single claim or multiple claims
    if 'claims' in request.json:
        return evaluate_multiple_claims()
    elif 'claim' in request.json:
        return evaluate_single_claim()
    else:
        logger.error("[EVALUATE] Error: Neither claim nor claims provided in request")
        return jsonify({'error': 'No claim or claims provided'}), 400

def evaluate_single_claim():
    """Evaluate a single claim using multiple AI providers in parallel"""
    start_time = time.time()
    claim = request.json.get('claim')
    context = request.json.get('context', '')
    model = request.json.get('model', 'all')
    
    # Generate a cache key for the entire request
    cache_key = f"eval_{hash(claim)}_{hash(context)}_{model}"
    
    # Check if we have a cached result for this exact request
    cached_result = response_cache.get(model="evaluate", prompt=cache_key, context="")
    if cached_result:
        logger.info(f"[EVALUATE] Using cached result for claim: '{claim[:30]}...'")
        return jsonify(cached_result)
    
    logger.info(f"[EVALUATE] Processing single claim: '{claim[:30]}...' with model: {model}")
    
    try:
        # Determine which models to evaluate
        models_to_evaluate = []
        if model == 'all':
            models_to_evaluate = ['perplexity', 'openai']
        else:
            models_to_evaluate = [model]
        
        # Store the current application for use in threads
        app = current_app._get_current_object()
        results = run_parallel_evaluation(app, claim, context, models_to_evaluate)
            
        duration = time.time() - start_time
        logger.info(f"[EVALUATE] Returning results with {len(results)} model evaluations in {duration:.2f}s")
        
        # Cache the result
        response_cache.set(model="evaluate", prompt=cache_key, value=results, context="")
        
        return jsonify(results)
    except Exception as e:
        error_message = f"Error evaluating claim: {str(e)}"
        logger.error(f"[EVALUATE] {error_message}\n{traceback.format_exc()}")
        return jsonify({'error': error_message}), 500

def evaluate_multiple_claims():
    """Evaluate multiple claims in parallel using multiple AI providers with improved performance"""
    start_time = time.time()
    claims = request.json.get('claims', [])
    context = request.json.get('context', '')
    model = request.json.get('model', 'all')
    
    if not claims or not isinstance(claims, list):
        return jsonify({'error': 'Invalid claims format. Expected a list of claims.'}), 400
    
    # Generate a cache key for this batch request
    claims_hash = hash(frozenset([(c.get('id', ''), c.get('claim', '')) for c in claims]))
    cache_key = f"eval_batch_{claims_hash}_{hash(context)}_{model}"
    
    # Check if we have a cached result for the entire batch
    cached_result = response_cache.get(model="evaluate_batch", prompt=cache_key, context="")
    if cached_result:
        logger.info(f"[EVALUATE] Using cached result for batch of {len(claims)} claims")
        return jsonify(cached_result)
    
    logger.info(f"[EVALUATE] Processing {len(claims)} claims in parallel with model: {model}")
    
    try:
        # Determine which models to evaluate - use just one model by default to improve performance
        models_to_evaluate = []
        if model == 'all':
            # For better performance, prioritize a single model unless specifically requested
            default_model = 'openai'  # Could be 'perplexity' based on your preference
            models_to_evaluate = [default_model]
        else:
            models_to_evaluate = [model]
        
        # Store the current application for use in threads
        app = current_app._get_current_object()
        
        # Process all claims in parallel using a ThreadPoolExecutor
        all_results = {}
        max_workers = min(len(claims), 4)  # Reduced from 8 to 4 for better resource management
        
        with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as executor:
            # Create a dictionary to track futures for each claim
            future_to_claim = {}
            
            # Submit all claims for processing
            for i, claim_data in enumerate(claims):
                claim_text = claim_data.get('claim')
                claim_id = claim_data.get('id', f"claim_{i}")
                claim_context = claim_data.get('context', '') 
                
                # Check if we have a cached result for this specific claim
                claim_cache_key = f"eval_{hash(claim_text)}_{hash(context)}_{hash(claim_context)}_{model}"
                cached_claim_result = response_cache.get(model="evaluate", prompt=claim_cache_key, context="")
                
                if cached_claim_result:
                    logger.info(f"[EVALUATE] Using cached result for claim {i+1}/{len(claims)}")
                    all_results[claim_id] = cached_claim_result
                    continue
                
                # Combine global context with claim-specific context
                combined_context = f"{context}\n\nClaim Context:\n{claim_context}" if claim_context else context
                
                # Submit for processing if not cached
                future = executor.submit(
                    run_parallel_evaluation,
                    app, 
                    claim_text,
                    combined_context,
                    models_to_evaluate,
                    claim_id
                )
                future_to_claim[future] = (claim_id, claim_cache_key)
            
            # Process results as they complete
            for future in concurrent.futures.as_completed(future_to_claim):
                claim_id, claim_cache_key = future_to_claim[future]
                try:
                    claim_results = future.result()
                    all_results[claim_id] = claim_results
                    
                    # Cache this individual claim result
                    response_cache.set(model="evaluate", prompt=claim_cache_key, value=claim_results, context="")
                    
                except Exception as exc:
                    logger.error(f"[EVALUATE] Claim {claim_id} generated an exception: {exc}")
                    all_results[claim_id] = {
                        "error": str(exc),
                        models_to_evaluate[0]: create_error_result(
                            claims[int(claim_id.split('_')[1]) if claim_id.startswith('claim_') else 0].get('claim'),
                            models_to_evaluate[0], 
                            str(exc)
                        )
                    }
        
        duration = time.time() - start_time
        logger.info(f"[EVALUATE] Returning results for {len(all_results)} claims with parallel evaluation in {duration:.2f}s")
        
        # Cache the entire batch result
        response_cache.set(model="evaluate_batch", prompt=cache_key, value=all_results, context="")
        
        return jsonify(all_results)
    except Exception as e:
        error_message = f"Error evaluating multiple claims: {str(e)}"
        logger.error(f"[EVALUATE] {error_message}\n{traceback.format_exc()}")
        return jsonify({'error': error_message}), 500

def run_parallel_evaluation(app, claim, context, models_to_evaluate, claim_id=None):
    """Run evaluation for a single claim across multiple models in parallel with improved timeouts"""
    start_time = time.time()
    results = {}
    
    # Check if we already have a cached response for this claim
    cache_key = f"eval_{hash(claim)}_{hash(context)}_{'_'.join(sorted(models_to_evaluate))}"
    cached_result = response_cache.get(model="run_parallel", prompt=cache_key, context="")
    
    if cached_result:
        logger.info(f"[EVALUATE] Using cached parallel evaluation for claim: '{claim[:30]}...'")
        
        # If a claim ID was provided, add it to each model result
        if claim_id:
            for model_name in cached_result:
                if isinstance(cached_result[model_name], dict):
                    cached_result[model_name]["claimId"] = claim_id
                    
        return cached_result
    
    # Define a function to process a single model
    def process_model(model_name):
        # Establish application context for this thread
        with app.app_context():
            try:
                if model_name == 'perplexity':
                    logger.info(f"[EVALUATE] Calling Perplexity API for claim: '{claim[:30]}...'")
                    result = evaluate_with_perplexity(claim, context)
                    logger.info("[EVALUATE] Perplexity evaluation successful")
                elif model_name == 'openai':
                    logger.info(f"[EVALUATE] Calling OpenAI API for claim: '{claim[:30]}...'")
                    result = evaluate_with_openai(claim, context)
                    logger.info("[EVALUATE] OpenAI evaluation successful")
                else:
                    return None, f"Unknown model: {model_name}"
                
                # Add the claim ID to the result if provided
                if claim_id:
                    result["claimId"] = claim_id
                    
                return model_name, result
            except Exception as model_error:
                logger.error(f"[EVALUATE] {model_name.capitalize()} evaluation failed: {str(model_error)}")
                error_result = create_error_result(claim, model_name, str(model_error))
                return model_name, error_result
    
    # Process all models in parallel using ThreadPoolExecutor
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(models_to_evaluate)) as executor:
        # Submit all tasks
        future_to_model = {executor.submit(process_model, model_name): model_name for model_name in models_to_evaluate}
        
        # Process results as they complete with a timeout
        timeout_per_model = 30  # Reduced from 45 to 30 seconds for better performance
        
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
                    logger.error(f"[EVALUATE] Timeout for model: {model_name}")
                    results[model_name] = create_error_result(
                        claim, model_name, f"Evaluation timed out after {timeout_per_model} seconds"
                    )
                except Exception as e:
                    logger.error(f"[EVALUATE] Error processing result for {model_name}: {str(e)}")
                    results[model_name] = create_error_result(
                        claim, model_name, f"Error: {str(e)}"
                    )
        except concurrent.futures.TimeoutError:
            logger.error(f"[EVALUATE] Overall evaluation timed out")
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
    
    duration = time.time() - start_time
    logger.info(f"[EVALUATE] Completed parallel evaluation in {duration:.2f}s")
    
    # Cache the results
    response_cache.set(model="run_parallel", prompt=cache_key, value=results, context="")
    
    return results

# Second run_parallel_evaluation function removed to fix duplication

def create_error_result(claim, model_name, error_message):
    """Create a standardized error result for a failed model evaluation"""
    return {
        "statement": claim,
        "classification": "UNVERIFIED",
        "confidence": 0,
        "supportingFacts": f"Error: {error_message}",
        "model": model_name.capitalize()
    }