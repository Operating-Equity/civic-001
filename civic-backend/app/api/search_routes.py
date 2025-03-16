from flask import request, jsonify, current_app
from app.api.api_routes import api
from app.services.search_service import (
    generate_keywords, 
    search_evidence, 
    search_evidence_batch,
    search_for_timebound_claim
)
import logging
import traceback
import time
import re
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor, as_completed

# Set up logging
logger = logging.getLogger(__name__)

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
        logger.error(f"Error generating keywords: {str(e)}\n{traceback.format_exc()}")
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
        # Process each claim to generate keywords using parallel processing
        results = []
        app = current_app._get_current_object()  # Get current app for thread safety
        
        with ThreadPoolExecutor(max_workers=min(8, len(claims))) as executor:
            # Create a dictionary to map futures to claim data
            future_to_claim = {}
            
            # Submit tasks for all claims
            for claim_data in claims:
                if not isinstance(claim_data, dict):
                    continue
                    
                claim = claim_data.get('claim')
                context = claim_data.get('context', '')
                validation_info = claim_data.get('validationPotential', '')
                claim_id = claim_data.get('id', '')
                
                if not claim:
                    continue
                
                # Submit the task to the executor with app context
                future = executor.submit(
                    generate_keywords_with_context,
                    app,
                    claim,
                    context,
                    validation_info,
                    video_title
                )
                future_to_claim[future] = {'id': claim_id, 'claim': claim}
            
            # Process results as they complete
            for future in as_completed(future_to_claim):
                claim_data = future_to_claim[future]
                try:
                    keywords = future.result()
                    results.append({
                        'id': claim_data['id'],
                        'claim': claim_data['claim'],
                        'searchQueries': keywords
                    })
                except Exception as e:
                    logger.error(f"Error generating keywords for claim: {claim_data['claim']}\n{str(e)}")
                    # Add the claim with a default query as fallback
                    results.append({
                        'id': claim_data['id'],
                        'claim': claim_data['claim'],
                        'searchQueries': [f"fact check {claim_data['claim'][:50]}"]
                    })
        
        return jsonify({'results': results})
    except Exception as e:
        logger.error(f"Error in batch keyword generation: {str(e)}\n{traceback.format_exc()}")
        return jsonify({'error': str(e)}), 500

# Helper function to run with proper app context
def generate_keywords_with_context(app, claim, context, validation_info, video_title):
    with app.app_context():
        return generate_keywords(claim, context, validation_info, video_title)

@api.route('/search/evidence', methods=['POST'])
def search_for_evidence():
    """Search for evidence related to keywords with improved error handling"""
    if not request.json:
        return jsonify({'error': 'Invalid request'}), 400
    
    query = request.json.get('query')
    claim = request.json.get('claim', '')
    detect_timebound = request.json.get('detect_timebound', False)
    
    if not query:
        return jsonify({'error': 'No search query provided'}), 400
        
    try:
        logger.info(f"Searching for evidence with query: {query}")
        
        # Detailed check for API key with helpful error message
        exa_api_key = current_app.config.get('EXA_API_KEY')
        if not exa_api_key:
            logger.error("EXA_API_KEY is not configured")
            logger.error("Please check .env file and Docker environment variables")
            # Return a more helpful error message
            return jsonify({
                'results': [],
                'error': 'Search API key not configured. Please add EXA_API_KEY to your .env file.'
            }), 200  # Return empty results but with a 200 status
            
        # Log API key status (safely)
        logger.info(f"Using EXA_API_KEY: {'[CONFIGURED]' if exa_api_key else '[MISSING]'}")
        logger.info(f"API key length: {len(exa_api_key) if exa_api_key else 0}")
        
        # Initialize client only when needed
        try:
            from exa_py import Exa
            # Test initialization
            exa_client = Exa(exa_api_key)
            logger.info("Successfully initialized Exa client")
        except ImportError:
            logger.error("Failed to import exa_py library. Is it installed?")
            return jsonify({
                'results': [],
                'error': 'Exa library not available. Run: pip install exa-py'
            }), 200
        except Exception as e:
            logger.error(f"Failed to initialize Exa client: {str(e)}")
            return jsonify({
                'results': [], 
                'error': f'Failed to initialize Exa client: {str(e)}'
            }), 200
        
        # Check if this is a timebound claim that needs special handling
        if detect_timebound and is_timebound_claim(claim):
            logger.info(f"Detected timebound claim, using specialized search")
            results = search_for_timebound_claim(claim)
        else:
            # Perform standard search
            results = search_evidence(query, claim)
        
        # Log stats about the results
        logger.info(f"Search complete. Found {len(results)} results")
        
        # Add additional metadata
        response_data = {
            'results': results,
            'queryInfo': {
                'query': query,
                'resultCount': len(results),
                'timestamp': datetime.now().isoformat(),
                'isTimebound': detect_timebound and is_timebound_claim(claim)
            }
        }
        
        return jsonify(response_data)
    except Exception as e:
        logger.error(f"Error searching for evidence: {str(e)}")
        logger.error(f"Stack trace: {traceback.format_exc()}")
        # Return empty results with an explanation rather than a 500 error
        return jsonify({
            'results': [],
            'error': f'Search error: {str(e)}'
        }), 200  # Return 200 status with empty results and error message

@api.route('/search/evidence/batch', methods=['POST'])
def search_for_evidence_batch():
    """Search for evidence across multiple queries in parallel"""
    if not request.json or 'queries' not in request.json:
        return jsonify({'error': 'No search queries provided'}), 400
        
    queries = request.json.get('queries')
    claim = request.json.get('claim', '')
    
    if not isinstance(queries, list):
        return jsonify({'error': 'Queries must be provided as a list'}), 400
    
    try:
        logger.info(f"Batch searching for evidence with {len(queries)} queries")
        
        # Check if API key is configured
        exa_api_key = current_app.config.get('EXA_API_KEY')
        if not exa_api_key:
            logger.error("EXA_API_KEY is not configured")
            # Return empty results for each query
            return jsonify({
                'results': [[] for _ in queries],
                'error': 'Search API key not configured. Please check your server configuration.'
            }), 200
        
        # Create app context outside the thread pool
        app = current_app._get_current_object()
        
        # Process queries in parallel
        start_time = time.time()
        results = []
        
        with ThreadPoolExecutor(max_workers=min(8, len(queries))) as executor:
            futures = []
            for query in queries:
                if not query or not isinstance(query, str):
                    results.append([])
                    continue
                
                # Pass the app to search_evidence function
                futures.append(executor.submit(
                    search_with_app_context, app, query, claim
                ))
            
            # Collect results as they complete
            for future in as_completed(futures):
                try:
                    result = future.result()
                    results.append(result)
                except Exception as e:
                    logger.error(f"Error in search thread: {str(e)}")
                    results.append([])
                    
        duration = time.time() - start_time
        
        logger.info(f"Batch search completed in {duration:.2f}s")
        
        # Add metadata to response
        response_data = {
            'results': results,
            'queryInfo': {
                'queryCount': len(queries),
                'totalResults': sum(len(res) for res in results),
                'processingTime': f"{duration:.2f}s",
                'timestamp': datetime.now().isoformat()
            }
        }
        
        return jsonify(response_data)
    except Exception as e:
        logger.error(f"Error in batch evidence search: {str(e)}\n{traceback.format_exc()}")
        # Return empty results for each query
        return jsonify({
            'results': [[] for _ in queries],
            'error': f'Search error: {str(e)}'
        }), 200

# Helper function to run search with proper app context
def search_with_app_context(app, query, claim):
    """Execute search within an app context"""
    with app.app_context():
        try:
            return search_evidence(query, claim)
        except Exception as e:
            logger.error(f"Error searching for '{query}': {str(e)}")
            return []
        
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
        app = current_app._get_current_object()  # Get current app for thread safety
        
        # Process claims in parallel with ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=min(4, len(claims))) as executor:
            # Create a dictionary to map futures to claims
            future_to_claim = {}
            
            # Submit tasks for all claims
            for claim_data in claims:
                if not isinstance(claim_data, dict):
                    continue
                    
                claim = claim_data.get('claim')
                context = claim_data.get('context', '')
                validation_info = claim_data.get('validationPotential', '')
                
                if not claim:
                    continue
                
                # Check if this is a timebound claim
                is_timebound = is_timebound_claim(claim)
                
                # Submit the task to the executor with app context
                future = executor.submit(
                    process_single_claim_evidence_with_context,
                    app,
                    claim,
                    context,
                    validation_info,
                    video_title,
                    is_timebound
                )
                future_to_claim[future] = claim
            
            # Process results as they complete
            for future in as_completed(future_to_claim):
                claim = future_to_claim[future]
                try:
                    claim_results = future.result()
                    all_results.append(claim_results)
                except Exception as e:
                    logger.error(f"Error processing claim evidence: {str(e)}")
                    # Add a placeholder result for failed claims
                    all_results.append({
                        'claim': claim,
                        'keywordResults': [],
                        'error': f"Error searching for evidence: {str(e)}"
                    })
        
        return jsonify({'results': all_results})
    except Exception as e:
        logger.error(f"Error in multi-claim evidence search: {str(e)}\n{traceback.format_exc()}")
        return jsonify({'error': str(e)}), 500

# Helper function to process claim with app context
def process_single_claim_evidence_with_context(app, claim, context, validation_info, video_title, is_timebound=False):
    with app.app_context():
        return process_single_claim_evidence(claim, context, validation_info, video_title, is_timebound)

def process_single_claim_evidence(claim: str, context: str, validation_info: str, video_title: str, is_timebound=False):
    """Helper function to process a single claim for evidence"""
    # First generate keywords
    keywords = generate_keywords(claim, context, validation_info, video_title)
    
    if is_timebound:
        # Add timebound results
        timebound_results = search_for_timebound_claim(claim, context)
        all_results = search_evidence_batch(keywords, claim)
        
        # Format results
        keyword_results = [{
            'keyword': "Current information (real-time search)",
            'results': timebound_results
        }]
        
        # Add regular keyword results
        for i, query in enumerate(keywords):
            keyword_results.append({
                'keyword': query,
                'results': all_results[i] if i < len(all_results) else []
            })
    else:
        # Standard search for all keywords
        all_results = search_evidence_batch(keywords, claim)
        
        # Format results
        keyword_results = []
        for i, query in enumerate(keywords):
            keyword_results.append({
                'keyword': query,
                'results': all_results[i] if i < len(all_results) else []
            })
    
    return {
        'claim': claim,
        'keywordResults': keyword_results,
        'isTimebound': is_timebound
    }

def is_timebound_claim(claim: str) -> bool:
    """
    Detect if a claim is about a recent or time-sensitive event
    
    Args:
        claim: The claim text to analyze
        
    Returns:
        True if claim appears to be about a recent event
    """
    if not claim:
        return False
        
    # Search for temporal indicators in the claim
    time_indicators = [
        r'\b(today|yesterday|last\s+week|this\s+week|this\s+month|this\s+year)\b',
        r'\b(recent(ly)?|latest|current|now|just|new)\b',
        r'\b(202[3-5])\b',  # Recent years (2023-2025)
        r'\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+202[3-5]\b'  # Month + recent year
    ]
    
    return any(re.search(pattern, claim, re.IGNORECASE) for pattern in time_indicators)