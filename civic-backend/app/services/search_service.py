import time
import json
import re
import concurrent.futures
import logging
import traceback
import requests
from typing import List, Dict, Any, Optional, Tuple
from datetime import datetime, timedelta
from flask import current_app, Flask
from app.services.openai_service import call_openai_api
from exa_py import Exa
from app.models.schemas import SearchResult

# Set up logging
logger = logging.getLogger(__name__)

MAX_RETRIES = 3
RETRY_DELAY = 1.2  # 1 second
MAX_CONCURRENT_SEARCHES = 2

# List of sources to exclude from search results
# These sources may have strong political biases or reliability issues
DISQUALIFIED_SOURCES = [
    "RedState", "American Greatness", "NewsBusters", "Twitchy", "The Gateway Pundit",
    "Timcast IRL", "NutriTruth", "HuffPost", "Morning Joe", "The Atlantic", "Media Matters",
    "The Lever", "AlterNet", "Slate", "In These Times", "Jacobin", "The Nation",
    "The New Republic", "Jezebel", "The Last Word", "TYT (The Young Turks)",
    "Right Wing Watch", "The Root", "Rolling Stone", "Inside", "Consortium News",
    "All In with Chris Hayes", "CounterPunch", "Wonkette", "Palmer Report",
    "PolitiZoom", "The Grayzone", "MSNBC", "CNN", "The Washington Post", "Variety",
    "ABC", "60 Minutes", "The View", "Cosmopolitan", "Chris Hayes", "The ReidOut",
    "Chapo Trap House", "The Conversation"
]

def generate_keywords(claim: str, context: str = "", validation_potential: str = "", video_title: str = "") -> List[str]:
    """
    Generate optimized search keywords for a claim using OpenAI
    Returns a list of search query strings designed to find relevant evidence
    
    Args:
        claim: The empirical claim to verify
        context: Additional context about the claim
        validation_potential: Suggestions for validating the claim
        video_title: Title of the source video
        
    Returns:
        List of search query strings
    """
    # Ensure we have application context
    if current_app:
        app = current_app._get_current_object()
    else:
        # For cases outside of request context, create a temporary app context
        from app import create_app
        app = create_app()
    
    with app.app_context():
        system_message = """You are an expert search query generator specializing in fact-checking. 
        Your goal is to create search queries that will find the most relevant evidence to verify factual claims.
        Focus on creating diverse queries that target different aspects of the claim and different potential sources of evidence."""
        
        # More detailed prompt with specific instructions for query generation
        prompt = f"""I need to fact-check the following claim:

CLAIM: "{claim}"

CONTEXT: {context}

VIDEO TITLE: {video_title}

VALIDATION APPROACH: {validation_potential}

Please generate 4 different search queries to find evidence that could verify or refute this claim. For each query:

1. Focus on the empirical facts (names, dates, statistics, events, etc.)
2. Create specific, direct phrases under 8 words each
3. Avoid quotation marks, special operators, or boolean syntax
4. Each query should target a different aspect or approach:
   - Query 1: Focus on the core factual assertion
   - Query 2: Include relevant names, places, or organizations
   - Query 3: Target statistics, data, or research about this topic
   - Query 4: Focus on timeline/dates or seek context from reliable sources

Format your response as a list of 4 plain search queries, one per line, without numbering or bullet points."""

        try:
            response = call_openai_api("gpt-4o", [
                {"role": "system", "content": system_message},
                {"role": "user", "content": prompt}
            ], temperature=0.5)  # Lower temperature for more consistent results
            
            content = response['choices'][0]['message']['content']
            
            # Extract queries as a list of strings
            keywords = [
                line.strip().replace('"', '').replace('*', '') for line in content.split('\n')
                if line.strip() and not line.strip().startswith('#')
                and not line.strip().startswith('Query')
            ]
            
            # Further clean up the queries
            cleaned_keywords = []
            for kw in keywords:
                # Remove numbering at the beginning
                kw = re.sub(r'^\d+\.\s*', '', kw)
                # Remove quotes and other special characters
                kw = kw.replace('"', '').replace('"', '').replace('"', '').replace(':', '')
                # Keep it concise - truncate to 8 words max if needed
                words = kw.split()
                if len(words) > 8:
                    kw = ' '.join(words[:8])
                
                if kw and len(kw.strip()) > 0:
                    cleaned_keywords.append(kw.strip())
            
            # Ensure we have at least one keyword
            if not cleaned_keywords and claim:
                # Fallback: create a simple search query from the claim
                simple_query = ' '.join(claim.split()[:6])
                cleaned_keywords = [simple_query]
                
            # Ensure we have at least 2 queries for diversity
            while len(cleaned_keywords) < 2 and len(cleaned_keywords) > 0:
                # Add variations of the first query
                base_query = cleaned_keywords[0]
                words = base_query.split()
                if len(words) > 3:
                    cleaned_keywords.append(' '.join(words[:3]))
                else:
                    cleaned_keywords.append(f"{base_query} facts")
            
            # Cap at 4 keywords to avoid excessive searches
            return cleaned_keywords[:4]
        except Exception as e:
            logger.error(f"Error generating keywords: {str(e)}")
            # Return a simplified version of the claim as a fallback
            words = claim.split()
            if len(words) > 6:
                return [' '.join(words[:6])]
            return [claim]

def determine_search_parameters(query: str, claim: str = "") -> Dict[str, Any]:
    """
    Determine optimal search parameters based on the query content.
    
    Args:
        query: The search query
        claim: The original claim (for additional context)
        
    Returns:
        Dictionary of search parameters
    """
    params = {
        "type": "auto"  
    }
    
    # Check for indicators that suggest academic or scientific content
    academic_indicators = ['research', 'study', 'science', 'statistics', 'data', 'journal', 'university', 'analysis']
    is_academic_query = any(indicator in query.lower() for indicator in academic_indicators)
    
    if is_academic_query:
        # For academic queries, prioritize research sources
        params.update({
            "type": "neural",
            "category": "research paper"
        })
    
    # For news events or policy issues
    news_indicators = ['news', 'policy', 'government', 'election', 'law', 'regulation', 'announced', 'said']
    is_news_query = any(indicator in query.lower() for indicator in news_indicators)
    
    if is_news_query:
        # For news queries, prioritize news sources
        params.update({
            "type": "auto",
            "category": "news"
        })
    
    return params

def search_evidence_batch(queries: List[str], claim: str = "", options: Optional[Dict[str, Any]] = None) -> List[List[SearchResult]]:
    """
    Search for evidence across multiple queries in parallel with improved error handling
    
    Args:
        queries: List of search queries
        claim: The original claim (for parameter optimization)
        options: Optional request options including abort signal
        
    Returns:
        List of search results for each query
    """
    if not queries:
        return []
        
    # Ensure we have options
    if options is None:
        options = {}
    
    # Get API key outside the thread pool to avoid context issues
    api_key = None
    try:
        from flask import current_app
        api_key = current_app.config.get('EXA_API_KEY')
        if not api_key:
            logger.error("Exa API key not configured")
            return [[] for _ in queries]  # Return empty results for all queries
    except Exception as e:
        logger.error(f"Error getting API key: {str(e)}")
        return [[] for _ in queries]  # Return empty results for all queries
    
    # Deduplicate queries to avoid redundant searches
    unique_queries = []
    seen = set()
    for query in queries:
        clean_query = query.strip() if isinstance(query, str) else ""
        if clean_query and clean_query not in seen:
            seen.add(clean_query)
            unique_queries.append(clean_query)
    
    logger.info(f"Searching for {len(unique_queries)} unique queries: {unique_queries}")
    
    # Initialize Exa client with the API key we already retrieved
    exa = Exa(api_key)
    
    # Process searches in parallel
    results_dict = {}
    
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(len(unique_queries), MAX_CONCURRENT_SEARCHES)) as executor:
        # Submit all searches
        future_to_query = {}
        for query in unique_queries:
            if query.strip():  # Only search for non-empty queries
                future = executor.submit(
                    _perform_single_search, 
                    exa,  # Pass the Exa client directly
                    query, 
                    claim,
                    options.get('signal')
                )
                future_to_query[future] = query
        
        # Collect results as they complete
        for future in concurrent.futures.as_completed(future_to_query):
            query = future_to_query[future]
            try:
                search_results = future.result()
                results_dict[query] = search_results
                logger.info(f"Found {len(search_results)} results for query: {query}")
            except Exception as e:
                logger.error(f"Error searching for '{query}': {str(e)}")
                results_dict[query] = []
    
    # Map results back to original query order
    results = [results_dict.get(query, []) for query in queries]
    
    return results


def search_evidence(query: str, claim: str = "") -> List[SearchResult]:
    """
    Search for evidence related to a query with improved error handling and logging
    
    Args:
        query: The search query
        claim: The original claim for context
        
    Returns:
        List of search results
    """
    # Detailed logging for debugging
    logger.info(f"Starting evidence search for query: '{query}', claim: '{claim[:50]}...' if len(claim) > 50 else claim")
    
    api_key = current_app.config.get('EXA_API_KEY')
    if not api_key:
        logger.error("CRITICAL ERROR: Exa API key not configured in environment")
        logger.error("Please add EXA_API_KEY to your .env file or Docker environment")
        return []
    
    # Log API key length (safe logging)
    logger.info(f"Using Exa API key with length: {len(api_key)}")
    
    # Initialize Exa client
    try:
        exa = Exa(api_key)
        logger.info("Successfully initialized Exa client")
    except Exception as e:
        logger.error(f"Failed to initialize Exa client: {str(e)}")
        return []
    
    try:
        # Get optimal search parameters with detailed logging
        search_params = determine_search_parameters(query, claim)
        logger.info(f"Using search parameters: {json.dumps(search_params)}")
        
        # Enhanced summary query for better context
        summary_query = "Provide key facts relevant to fact-checking"
        if claim:
            summary_query = f"Provide key facts relevant to verifying: {claim}"
        
        logger.info(f"Executing Exa search_and_contents with query: {query}")
        start_time = time.time()
        
        # Use search_and_contents method with parameters exactly as in examples
        response = exa.search_and_contents(
            query=query,
            text=True,
            highlights={
                "numSentences": 3,
                "highlightsPerUrl": 2,
                "query": f"Evidence about {query}"
            },
            summary={
                "query": summary_query
            },
            subpages=1,
            subpage_target="sources",
            extras={
                "links": 3,
                "image_links": 1
            },
            num_results=10,
            **search_params
        )
        
        search_time = time.time() - start_time
        logger.info(f"Exa search completed in {search_time:.2f}s")
        
        # Validate response format
        if not hasattr(response, 'results'):
            logger.error(f"Invalid response from Exa API: missing 'results' attribute")
            logger.error(f"Response: {str(response)[:200]}")
            return []
        
        results = response.results
        logger.info(f"Raw search returned {len(results)} results")
        
        # Log first result for debugging
        if results and len(results) > 0:
            first_result = results[0]
            logger.info(f"First result title: {first_result.title if hasattr(first_result, 'title') else 'No title'}")
            logger.info(f"First result URL: {first_result.url if hasattr(first_result, 'url') else 'No URL'}")
        
        # Filter out disqualified sources
        filtered_results = [
            result for result in results
            if not any(source.lower() in (result.title.lower() if hasattr(result, 'title') and result.title else "") or
                      source.lower() in (result.url.lower() if hasattr(result, 'url') and result.url else "")
                      for source in DISQUALIFIED_SOURCES)
        ]
        
        logger.info(f"After filtering disqualified sources: {len(filtered_results)} results")
        
        # Process and rank results
        processed_results = process_search_results(filtered_results)
        ranked_results = rank_results(processed_results, query, claim)
        
        logger.info(f"Returning {len(ranked_results[:10])} final results")
        
        # Return top results
        return ranked_results[:10]
            
    except Exception as e:
        # Detailed error logging to help diagnose issues
        logger.error(f"Error in Exa search: {str(e)}")
        logger.error(f"Error type: {type(e).__name__}")
        logger.error(f"Stack trace: {traceback.format_exc()}")
        
        if isinstance(e, requests.exceptions.RequestException):
            logger.error(f"Request error details: {str(e)}")
            if hasattr(e, 'response') and e.response:
                logger.error(f"Response status code: {e.response.status_code}")
                logger.error(f"Response body: {e.response.text[:500]}")
        
        return []
    
def _perform_single_search(exa_client, query, claim, signal=None):
    """Perform a single search operation with the provided Exa client with improved error handling"""
    for attempt in range(MAX_RETRIES):
        try:
            # Simplify the query by removing excess quotes
            simplified_query = query
            if isinstance(query, str):
                simplified_query = query.replace('"', '').replace('"', '').replace('"', '')
            
            logger.info(f"Searching with query: {simplified_query}, attempt {attempt+1}/{MAX_RETRIES}")
            
            # Get optimal search parameters
            search_params = determine_search_parameters(simplified_query, claim)
            
            # Enhanced summary query for better context
            summary_query = "Provide key facts relevant to fact-checking"
            if claim:
                summary_query = f"Provide key facts relevant to verifying: {claim}"
            
            # Use search_and_contents method with parameters exactly as in examples
            response = exa_client.search_and_contents(
                query=simplified_query,
                text=True,
                highlights={
                    "numSentences": 3,
                    "highlightsPerUrl": 2,
                    "query": f"Evidence about {simplified_query}"
                },
                summary={
                    "query": summary_query
                },
                subpages=1,
                subpage_target="sources",
                extras={
                    "links": 3,
                    "image_links": 1
                },
                num_results=10,
                **search_params
            )
            
            # Validate response format before proceeding
            if not hasattr(response, 'results'):
                logger.warning(f"Invalid response format from Exa API on attempt {attempt+1}")
                if attempt < MAX_RETRIES - 1:
                    time.sleep(RETRY_DELAY * (2 ** attempt))  # Exponential backoff
                    continue
                return []  # Return empty results after all retries
            
            results = response.results
            
            # Filter out disqualified sources
            filtered_results = [
                result for result in results
                if not any(source.lower() in (result.title.lower() if hasattr(result, 'title') and result.title else "") or
                          source.lower() in (result.url.lower() if hasattr(result, 'url') and result.url else "")
                          for source in DISQUALIFIED_SOURCES)
            ]
            
            # Process and rank results
            processed_results = process_search_results(filtered_results)
            ranked_results = rank_results(processed_results, simplified_query, claim)
            
            # Return top results after ranking
            return ranked_results[:10]  # Limit to top 10 most relevant results
                
        except Exception as e:
            logger.error(f"Error in Exa search (attempt {attempt+1}/{MAX_RETRIES}): {str(e)}")
            
            # Specific handling for HTTP 500 errors
            if hasattr(e, 'response') and hasattr(e.response, 'status_code') and e.response.status_code == 500:
                logger.warning(f"Exa API returned 500 error, waiting before retry")
                
            # If this isn't our last retry, wait and try again
            if attempt < MAX_RETRIES - 1:
                wait_time = RETRY_DELAY * (2 ** attempt)  # Exponential backoff
                logger.info(f"Retrying in {wait_time} seconds...")
                time.sleep(wait_time)
            else:
                logger.error(f"All {MAX_RETRIES} attempts failed, returning empty results")
                return []  # Return empty results after all retries
    
    # Should not reach here, but just in case
    return []

def fetch_specific_content(urls: List[str], query: str = "", claim: str = "") -> List[Dict[str, Any]]:
    """
    Directly fetch content from specific URLs with advanced options
    Useful for retrieving detailed information from known sources
    
    Args:
        urls: List of URLs to retrieve content from
        query: Optional query to customize highlights/summary
        claim: The original claim for context
        
    Returns:
        List of content results
    """
    # Ensure we have application context
    if not current_app:
        # Create application context if not in request context
        from app import create_app
        app = create_app()
        ctx = app.app_context()
        ctx.push()
    else:
        app = current_app._get_current_object()
        ctx = None
        
    try:
        api_key = app.config.get('EXA_API_KEY')
        if not api_key:
            logger.error("Exa API key not configured")
            if ctx:
                ctx.pop()
            return []
        
        # Initialize Exa client
        exa = Exa(api_key)
        
        # Create custom highlight and summary queries
        highlight_query = query if query else "Key evidence and facts"
        if claim:
            highlight_query = f"Evidence relevant to: {claim}"
        
        summary_query = "Main facts and findings"
        if claim:
            summary_query = f"Information relevant to verifying: {claim}"
        
        # Get content with parameters exactly as in examples
        response = exa.get_contents(
            urls=urls,
            text={
                "maxCharacters": 10000,
                "includeHtmlTags": False
            },
            highlights={
                "numSentences": 3,
                "highlightsPerUrl": 2,
                "query": highlight_query
            },
            summary={
                "query": summary_query
            },
            subpages=1,
            subpage_target="references",
            extras={
                "links": 3,
                "image_links": 1
            }
        )
        
        # Process the results
        results = response.results
        processed_results = []
        
        for result in results:
            # Calculate credibility score
            credibility_score = calculate_credibility_score(result.url if hasattr(result, 'url') else "")
            
            # Process links if available
            links = []
            if hasattr(result, 'extras') and hasattr(result.extras, 'links') and result.extras.links:
                links = result.extras.links
            
            # Process image links if available
            image_links = []
            if hasattr(result, 'extras') and hasattr(result.extras, 'image_links') and result.extras.image_links:
                image_links = result.extras.image_links
            
            # Get subpages if available
            subpages = []
            if hasattr(result, 'subpages') and result.subpages:
                subpages = result.subpages
            
            # Clean up and standardize fields
            processed_result = {
                'title': result.title if hasattr(result, 'title') and result.title else 'Untitled',
                'url': result.url if hasattr(result, 'url') else '',
                'publishedDate': result.published_date if hasattr(result, 'published_date') else '',
                'author': result.author if hasattr(result, 'author') and result.author else 'Unknown',
                'text': result.text if hasattr(result, 'text') else '',
                'summary': result.summary if hasattr(result, 'summary') and result.summary else '',
                'credibilityScore': credibility_score,
                'domain': extract_domain(result.url if hasattr(result, 'url') else ""),
                'highlights': result.highlights if hasattr(result, 'highlights') else [],
                'links': links,
                'imageLinks': image_links,
                'subpages': subpages
            }
            
            processed_results.append(processed_result)
        
        # Clean up context if we created it
        if ctx:
            ctx.pop()
            
        return processed_results
        
    except Exception as e:
        logger.error(f"Error fetching specific content: {str(e)}")
        # Clean up context if we created it
        if ctx:
            ctx.pop()
        return []

def search_for_timebound_claim(claim: str, context: str = "") -> List[Dict[str, Any]]:
    """
    Special search function optimized for recent or timebound claims
    Uses search parameters optimized for recent content
    
    Args:
        claim: The claim to verify
        context: Additional context
        
    Returns:
        List of search results with recent information
    """
    # Ensure we have application context
    if not current_app:
        # Create application context if not in request context
        from app import create_app
        app = create_app()
        ctx = app.app_context()
        ctx.push()
    else:
        app = current_app._get_current_object()
        ctx = None
        
    try:
        api_key = app.config.get('EXA_API_KEY')
        if not api_key:
            logger.error("Exa API key not configured")
            if ctx:
                ctx.pop()
            return []
        
        # Initialize Exa client
        exa = Exa(api_key)
        
        # Generate a focused query targeting the timebound aspect
        query = extract_timebound_query(claim)
        
        # Custom summary query for timebound claims
        summary_query = f"Most recent facts about: {query}"
        
        # Search with parameters optimized for recent content
        response = exa.search_and_contents(
            query=query,
            text=True,
            highlights={
                "numSentences": 3,
                "highlightsPerUrl": 2,
                "query": f"Recent information about {query}"
            },
            summary={
                "query": summary_query
            },
            type="auto",
            num_results=10,
            subpages=1,
            subpage_target="sources",
            extras={
                "links": 3,
                "image_links": 1
            }
        )
        
        results = response.results
        
        # Process and rank results (same as in search_evidence)
        filtered_results = [
            result for result in results
            if not any(source.lower() in (result.title.lower() if result.title else "") or
                      source.lower() in (result.url.lower() if result.url else "")
                      for source in DISQUALIFIED_SOURCES)
        ]
        
        processed_results = []
        for result in filtered_results:
            # Get summary from the API response
            summary = result.summary if hasattr(result, 'summary') and result.summary else ""
            
            # Use highlights if no summary available
            if not summary and hasattr(result, 'highlights') and result.highlights:
                summary = " ".join(result.highlights[:2])
            
            # Calculate credibility score
            credibility_score = calculate_credibility_score(result.url if hasattr(result, 'url') else "")
            
            # Process links if available
            links = []
            if hasattr(result, 'extras') and hasattr(result.extras, 'links') and result.extras.links:
                links = result.extras.links
            
            # Process image links if available
            image_links = []
            if hasattr(result, 'extras') and hasattr(result.extras, 'image_links') and result.extras.image_links:
                image_links = result.extras.image_links
            
            processed_result = {
                'title': result.title if hasattr(result, 'title') and result.title else 'Untitled',
                'url': result.url if hasattr(result, 'url') else '',
                'publishedDate': result.published_date if hasattr(result, 'published_date') else '',
                'author': result.author if hasattr(result, 'author') and result.author else 'Unknown',
                'score': result.score if hasattr(result, 'score') else 0,
                'text': result.text if hasattr(result, 'text') else '',
                'summary': summary,
                'credibilityScore': credibility_score,
                'domain': extract_domain(result.url if hasattr(result, 'url') else ""),
                'highlights': result.highlights if hasattr(result, 'highlights') else [],
                'links': links,
                'imageLinks': image_links,
                'isLiveCrawl': True  # Mark as recent result
            }
            
            processed_results.append(processed_result)
        
        # Apply enhanced result ranking
        ranked_results = rank_results(processed_results, query, claim)
        
        # Clean up context if we created it
        if ctx:
            ctx.pop()
            
        return ranked_results[:10]
        
    except Exception as e:
        logger.error(f"Error in timebound search: {str(e)}")
        # Clean up context if we created it
        if ctx:
            ctx.pop()
        return []

def extract_timebound_query(claim: str) -> str:
    """
    Extract a focused query for timebound claims
    
    Args:
        claim: The claim to process
        
    Returns:
        A query optimized for finding recent information
    """
    # Look for time-related keywords in the claim
    time_keywords = ['today', 'yesterday', 'this week', 'this month', 'this year', 
                     'recent', 'latest', 'current', 'now', 'just', 'new']
    
    # Extract dates (numerical patterns that could be dates)
    date_pattern = r'\b(19|20)\d{2}[-/]?(0[1-9]|1[012])[-/]?(0[1-9]|[12][0-9]|3[01])\b|\b(0[1-9]|1[012])[-/]?(0[1-9]|[12][0-9]|3[01])[-/]?(19|20)\d{2}\b|\b(19|20)\d{2}\b'
    dates = re.findall(date_pattern, claim)
    
    # Extract words around time indicators
    words = claim.split()
    query_parts = []
    
    # Add dates if found
    if dates:
        date_str = ' '.join([d[0] for d in dates if d[0]])
        query_parts.append(date_str)
    
    # Add time keywords and surrounding context
    for keyword in time_keywords:
        if keyword in claim.lower():
            idx = claim.lower().find(keyword)
            start_idx = max(0, idx - 20)
            end_idx = min(len(claim), idx + 30)
            context = claim[start_idx:end_idx]
            query_parts.append(context)
    
    # If no time indicators found, use the first part of the claim
    if not query_parts:
        query_parts = [' '.join(words[:8])]
    
    # Build the final query (limited to reasonable length)
    query = ' '.join(query_parts)
    words = query.split()
    if len(words) > 10:
        query = ' '.join(words[:10])
    
    return query

def process_search_results(results):
    """Process raw search results into a standardized format"""
    processed_results = []
    
    for result in results:
        # Get the summary from the Exa API response
        summary = result.summary if hasattr(result, 'summary') and result.summary else ""
        
        # If no summary but we have text, generate one
        if not summary and hasattr(result, 'text') and result.text and len(result.text) > 200:
            try:
                summary = result.text[:200] + '...'  # Simple truncation as fallback
            except Exception as e:
                summary = ''
        
        # If still no summary, use highlights
        if not summary and hasattr(result, 'highlights') and result.highlights and len(result.highlights) > 0:
            summary = result.highlights[0]
        
        # Calculate a credibility score based on the domain
        credibility_score = calculate_credibility_score(result.url if hasattr(result, 'url') else "")
        
        # Process links from extras if available
        links = []
        if hasattr(result, 'extras') and hasattr(result.extras, 'links') and result.extras.links:
            links = result.extras.links
        
        # Process image links from extras if available
        image_links = []
        if hasattr(result, 'extras') and hasattr(result.extras, 'image_links') and result.extras.image_links:
            image_links = result.extras.image_links
        
        # Get subpages if available
        subpages = []
        if hasattr(result, 'subpages') and result.subpages:
            subpages = result.subpages
        
        # Clean up and standardize fields
        processed_result = {
            'title': result.title if hasattr(result, 'title') and result.title else 'Untitled',
            'url': result.url if hasattr(result, 'url') else '',
            'publishedDate': result.published_date if hasattr(result, 'published_date') else '',
            'author': result.author if hasattr(result, 'author') and result.author else 'Unknown',
            'score': result.score if hasattr(result, 'score') else 0,
            'text': result.text if hasattr(result, 'text') else '',
            'summary': summary,
            'credibilityScore': credibility_score,
            'domain': extract_domain(result.url if hasattr(result, 'url') else ""),
            'highlights': result.highlights if hasattr(result, 'highlights') else [],
            'links': links,
            'imageLinks': image_links,
            'subpages': subpages
        }
        
        processed_results.append(processed_result)
    
    return processed_results

def rank_results(results: List[Dict[str, Any]], query: str, claim: str = "") -> List[Dict[str, Any]]:
    """
    Enhanced ranking of search results based on multiple factors
    
    Args:
        results: List of search results
        query: The search query used
        claim: The original claim
        
    Returns:
        Ranked list of search results
    """
    # Skip ranking if no results or just one result
    if not results or len(results) <= 1:
        return results
    
    # Calculate a combined score for each result
    for result in results:
        # Start with the relevance score from Exa
        base_score = result.get('score', 0) or 0  # Use 0 if score is None
        
        # Boost for credible domains
        credibility_score = result.get('credibilityScore', 0) or 0  # Use 0 if None
        credibility_boost = credibility_score * 0.2
        
        # Boost for results with highlights that match keywords
        highlight_boost = 0
        query_terms = set(query.lower().split())
        
        if 'highlights' in result and result['highlights']:
            highlight_text = ' '.join(result['highlights']).lower()
            matches = sum(1 for term in query_terms if term in highlight_text)
            highlight_boost = min(0.15, 0.03 * matches)
        
        # Boost for recency (if publication date is available)
        recency_boost = 0
        if result.get('publishedDate'):
            try:
                pub_date = datetime.fromisoformat(result['publishedDate'].replace('Z', '+00:00'))
                days_old = (datetime.now() - pub_date).days
                # Newer content gets higher boost (max 0.1)
                recency_boost = max(0, 0.1 - (days_old / 365) * 0.1)
            except:
                pass
        
        # Calculate combined score
        result['combined_score'] = base_score + credibility_boost + highlight_boost + recency_boost
    
    # Sort by combined score (descending)
    sorted_results = sorted(results, key=lambda x: x.get('combined_score', 0), reverse=True)
    
    # Remove the combined_score field before returning
    for result in sorted_results:
        if 'combined_score' in result:
            del result['combined_score']
    
    return sorted_results

def calculate_credibility_score(url: str) -> float:
    """
    Calculate a credibility score for a source based on its domain
    
    Args:
        url: The URL of the source
        
    Returns:
        Credibility score (0.0 to 1.0)
    """
    domain = extract_domain(url)
    
    # High credibility for academic, government, and established organizations
    if domain.endswith(('.edu', '.gov', '.org')):
        return 0.8
    
    # Known reliable news sources
    reliable_news = ['reuters.com', 'apnews.com', 'nature.com', 'science.org', 
                    'nih.gov', 'who.int', 'un.org', 'europa.eu']
    if any(source in domain for source in reliable_news):
        return 1.0
    
    # General news sites get a moderate score
    if domain.endswith(('.com', '.net')):
        return 0.5
    
    # Default score for other domains
    return 0.3

def extract_domain(url: str) -> str:
    """
    Extract the domain from a URL
    
    Args:
        url: The URL to process
        
    Returns:
        Domain name
    """
    if not url:
        return ""
        
    # Remove protocol and path
    domain = re.sub(r'https?://', '', url)
    domain = domain.split('/', 1)[0]
    
    # Remove subdomains except 'www'
    parts = domain.split('.')
    if len(parts) > 2:
        if parts[0] == 'www':
            domain = '.'.join(parts[1:])
        else:
            # Keep the main domain (usually last 2 parts)
            domain = '.'.join(parts[-2:])
    
    return domain

def summarize_text(text: str, max_length: int = 1500) -> str:
    """
    Summarize long text using OpenAI with improved prompt
    
    Args:
        text: The text to summarize
        max_length: Maximum length of text to process
        
    Returns:
        Summarized text
    """
    # Truncate text if necessary to avoid token limits
    if len(text) > max_length:
        text = text[:max_length] + "..."
    
    system_message = "You are an expert at summarizing text concisely while preserving key facts and statistics."
    
    prompt = f"""Summarize the following text, focusing on factual information, key statistics, and verifiable claims:

{text}

Provide a factual summary in 2-3 sentences that captures the most important verifiable information. Include any specific numbers, dates, or measurements mentioned."""

    try:
        response = call_openai_api("gpt-4o-mini", [
            {"role": "system", "content": system_message},
            {"role": "user", "content": prompt}
        ], temperature=0.3, max_tokens=150)
        
        return response['choices'][0]['message']['content']
    except Exception as e:
        logger.error(f"Error summarizing text: {str(e)}")
        # Fall back to a simple truncation
        return text[:200] + "..."