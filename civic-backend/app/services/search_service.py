import time
import json
import re
import concurrent.futures
import logging
from typing import List, Dict, Any, Optional, Tuple
from datetime import datetime, timedelta
from flask import current_app
from app.services.openai_service import call_openai_api
from exa_py import Exa

# Set up logging
logger = logging.getLogger(__name__)

MAX_RETRIES = 3
RETRY_DELAY = 1  # 1 second
MAX_CONCURRENT_SEARCHES = 8  # Maximum number of concurrent searches

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
        "numResults": 15,  # Request more results to have better filtering options
        "useAutoprompt": True
    }
    
    # Check if the query contains temporal indicators suggesting a recent event
    recent_indicators = ['recently', 'last week', 'this month', 'this year', '2024', '2023', 'latest', 'current']
    needs_recent_results = any(indicator in query.lower() or indicator in claim.lower() for indicator in recent_indicators)
    
    if needs_recent_results:
        # For recent events, use livecrawl and limit to recent publications
        one_year_ago = (datetime.now() - timedelta(days=365)).strftime('%Y-%m-%dT%H:%M:%S.%fZ')
        params.update({
            "livecrawl": "fallback",  # Use live crawling if not in cache
            "startPublishedDate": one_year_ago
        })
    
    # Check for indicators that suggest academic or scientific content
    academic_indicators = ['research', 'study', 'science', 'statistics', 'data', 'journal', 'university', 'analysis']
    is_academic_query = any(indicator in query.lower() for indicator in academic_indicators)
    
    if is_academic_query:
        # For academic queries, prioritize research sources
        params.update({
            "type": "neural",  # Neural search better for academic content
            "category": "research paper",
            # Add specific academic domains
            "includeDomains": [
                "nih.gov", "nature.com", "science.org", "pnas.org", "springer.com", 
                "jstor.org", "ssrn.com", "arxiv.org", "pubmed.gov", "elsevier.com"
            ]
        })
    
    # For news events or policy issues
    news_indicators = ['news', 'policy', 'government', 'election', 'law', 'regulation', 'announced', 'said']
    is_news_query = any(indicator in query.lower() for indicator in news_indicators)
    
    if is_news_query:
        # For news queries, prioritize news sources
        params.update({
            "type": "auto",  # Let Exa decide between neural/keyword
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

# Helper function to perform a single search without requiring app context
def _perform_single_search(exa_client, query, claim, signal=None):
    """Perform a single search operation with the provided Exa client"""
    try:
        # Simplify the query by removing excess quotes
        simplified_query = query
        if isinstance(query, str):
            simplified_query = query.replace('"', '').replace('"', '').replace('"', '')
        
        logger.info(f"Searching with query: {simplified_query}")
        
        # Get optimal search parameters
        search_params = determine_search_parameters(simplified_query, claim)
        
        # Enhanced summary query for better context
        summary_query = "Provide key facts relevant to fact-checking"
        if claim:
            summary_query = f"Provide key facts relevant to verifying: {claim}"
        
        # Use search_and_contents method with advanced parameters
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
            **search_params
        )
        
        results = response.results
        
        # Filter out disqualified sources
        filtered_results = [
            result for result in results
            if not any(source.lower() in (result.title.lower() if result.title else "") or
                      source.lower() in (result.url.lower() if result.url else "")
                      for source in DISQUALIFIED_SOURCES)
        ]
        
        # Process and rank results
        processed_results = process_search_results(filtered_results)
        ranked_results = rank_results(processed_results, simplified_query, claim)
        
        # Return top results after ranking
        return ranked_results[:10]  # Limit to top 10 most relevant results
            
    except Exception as e:
        logger.error(f"Error in Exa search: {str(e)}")
        return []  # Return empty results on error

# Helper to process search results
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

def search_evidence_batch(queries: List[str], claim: str = "") -> List[List[Dict[str, Any]]]:
    """
    Search for evidence across multiple queries in parallel with improved error handling
    
    Args:
        queries: List of search queries
        claim: The original claim (for parameter optimization)
        
    Returns:
        List of search results for each query
    """
    if not queries:
        return []
    
    # Deduplicate queries to avoid redundant searches
    unique_queries = []
    seen = set()
    for query in queries:
        clean_query = query.strip() if isinstance(query, str) else ""
        if clean_query and clean_query not in seen:
            seen.add(clean_query)
            unique_queries.append(clean_query)
    
    logger.info(f"Searching for {len(unique_queries)} unique queries: {unique_queries}")
    
    # Process searches in parallel
    results_dict = {}
    
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(len(unique_queries), MAX_CONCURRENT_SEARCHES)) as executor:
        # Submit all searches
        future_to_query = {}
        for query in unique_queries:
            if query.strip():  # Only search for non-empty queries
                future = executor.submit(search_evidence, query, claim)
                future_to_query[future] = query
        
        # Collect results as they complete
        for future in concurrent.futures.as_completed(future_to_query):
            query = future_to_query[future]
            try:
                results = future.result()
                results_dict[query] = results
                logger.info(f"Found {len(results)} results for query: {query}")
            except Exception as e:
                logger.error(f"Error searching for '{query}': {str(e)}")
                results_dict[query] = []
    
    # Map results back to original query order
    results = [results_dict.get(query, []) for query in queries]
    
    return results

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
    api_key = current_app.config.get('EXA_API_KEY')
    if not api_key:
        logger.error("Exa API key not configured")
        return []
    
    # Initialize Exa client
    exa = Exa(api_key)
    
    try:
        # Create custom highlight and summary queries
        highlight_query = query if query else "Key evidence and facts"
        if claim:
            highlight_query = f"Evidence relevant to: {claim}"
        
        summary_query = "Main facts and findings"
        if claim:
            summary_query = f"Information relevant to verifying: {claim}"
        
        # Get content with advanced options
        response = exa.get_contents(
            urls=urls,
            text={
                "maxCharacters": 10000,  # Get up to 10k chars
                "includeHtmlTags": False # Clean text without HTML
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
        
        return processed_results
        
    except Exception as e:
        logger.error(f"Error fetching specific content: {str(e)}")
        return []

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
        base_score = result.get('score', 0)
        
        # Boost for credible domains
        credibility_boost = result.get('credibilityScore', 0) * 0.2
        
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
        response = call_openai_api("gpt-3.5-turbo", [
            {"role": "system", "content": system_message},
            {"role": "user", "content": prompt}
        ], temperature=0.3, max_tokens=150)
        
        return response['choices'][0]['message']['content']
    except Exception as e:
        logger.error(f"Error summarizing text: {str(e)}")
        # Fall back to a simple truncation
        return text[:200] + "..."

def search_for_timebound_claim(claim: str, context: str = "") -> List[Dict[str, Any]]:
    """
    Special search function optimized for recent or timebound claims
    Uses livecrawl to find the most up-to-date information
    
    Args:
        claim: The claim to verify
        context: Additional context
        
    Returns:
        List of search results with real-time information
    """
    api_key = current_app.config.get('EXA_API_KEY')
    if not api_key:
        logger.error("Exa API key not configured")
        return []
    
    # Initialize Exa client
    exa = Exa(api_key)
    
    try:
        # Generate a focused query targeting the timebound aspect
        query = extract_timebound_query(claim)
        
        # Custom summary query for timebound claims
        summary_query = f"Most recent facts about: {query}"
        
        # Search with livecrawl enabled and optimized parameters
        response = exa.search_and_contents(
            query=query,
            text=True,                  # Include full text
            highlights={                # Optimized highlights
                "numSentences": 3,
                "highlightsPerUrl": 2,
                "query": f"Recent information about {query}"
            },
            summary={                   # Custom summary query
                "query": summary_query
            },
            livecrawl="always",         # Always use livecrawl for recent claims
            livecrawlTimeout=15000,     # Extended timeout (15s)
            numResults=15,
            useAutoprompt=True,
            extras={                    # Get additional content
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
                'isLiveCrawl': True  # Mark as livecrawl result
            }
            
            processed_results.append(processed_result)
        
        # Apply enhanced result ranking
        ranked_results = rank_results(processed_results, query, claim)
        
        return ranked_results[:10]
        
    except Exception as e:
        logger.error(f"Error in timebound search: {str(e)}")
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