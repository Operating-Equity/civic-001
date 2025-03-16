import time
import json
import concurrent.futures
from flask import current_app
from app.services.openai_service import call_openai_api
from exa_py import Exa

MAX_RETRIES = 3
RETRY_DELAY = 1  # 1 second
MAX_CONCURRENT_SEARCHES = 8  # Maximum number of concurrent searches

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

def generate_keywords(claim, context="", validation_potential="", video_title=""):
    """
    Generate search keywords for a claim using OpenAI
    Returns a list of search query strings
    """
    system_message = "You are an expert in crafting effective search queries."
    
    prompt = f"""Given the following:

{video_title and f"Video Title: {video_title}" or ""}
- Claim: {claim}
- Context: {context}
- Validation Potential: {validation_potential}

Generate three effective search queries to verify or debunk the claim by:

1. Using simple, direct language without quotation marks
2. Including key terms but keeping queries under 8 words
3. Focusing on facts and statistics rather than opinions
4. Avoiding complex boolean operators or special syntax
5. Making each query distinct to cover different aspects of the claim

Each search query should be optimized to return reliable information related to the empirical claim."""

    try:
        response = call_openai_api("gpt-4o", [
            {"role": "system", "content": system_message},
            {"role": "user", "content": prompt}
        ], temperature=0.7)
        
        content = response['choices'][0]['message']['content']
        
        # Extract queries as a list of strings
        keywords = [
            line.strip().replace('"', '') for line in content.split('\n')
            if line.strip() and not line.strip().startswith('#')
            and not line.strip().startswith('Search Query')
        ]
        
        # Clean up the queries to remove quotation marks and numbering
        cleaned_keywords = []
        for kw in keywords:
            # Remove numbering at the beginning (like "1.", "2.", etc.)
            kw = re.sub(r'^\d+\.\s*', '', kw)
            # Remove quotes
            kw = kw.replace('"', '').replace('"', '').replace('"', '')
            if kw:
                cleaned_keywords.append(kw)
        
        return cleaned_keywords
    except Exception as e:
        print(f"Error generating keywords: {str(e)}")
        return [f"fact check {claim}"]  # Fallback query

def search_evidence(query):
    """
    Search for evidence related to a query using Exa SDK
    Returns a list of search results
    """
    api_key = current_app.config.get('EXA_API_KEY')
    if not api_key:
        raise Exception("Exa API key not configured")
    
    # Initialize Exa client
    exa = Exa(api_key)
    
    for attempt in range(MAX_RETRIES):
        try:
            # Simplify the query by removing excess quotes if present
            query = query.replace('"', '').replace('"', '').replace('"', '')
            
            # Use broader search parameters
            response = exa.search_and_contents(
                query=query,
                text=True,
                highlights=True,
                num_results=25,
                use_autoprompt=True,
            )
            
            results = response.results
            
            # Filter out disqualified sources
            filtered_results = [
                result for result in results
                if not any(source.lower() in result.title.lower() if result.title else False
                          for source in DISQUALIFIED_SOURCES)
            ]
            
            # Process results to add summaries
            processed_results = []
            for result in filtered_results:
                # Generate a summary if we have enough text
                if hasattr(result, 'text') and result.text and len(result.text) > 200:
                    try:
                        summary = summarize_text(result.text)
                    except Exception as e:
                        print(f"Error generating summary: {str(e)}")
                        summary = result.text[:200] + '...' if result.text else ''
                else:
                    # Use highlights as summary if available
                    if hasattr(result, 'highlights') and result.highlights and len(result.highlights) > 0:
                        summary = result.highlights[0]
                    else:
                        summary = result.text[:200] + '...' if hasattr(result, 'text') and result.text else ''
                
                # Clean up and standardize fields
                processed_result = {
                    'title': result.title if hasattr(result, 'title') and result.title else 'Untitled',
                    'url': result.url,
                    'publishedDate': result.published_date if hasattr(result, 'published_date') else '',
                    'author': result.author if hasattr(result, 'author') and result.author else 'Unknown',
                    'score': result.score if hasattr(result, 'score') else 0,
                    'text': result.text if hasattr(result, 'text') else '',
                    'summary': summary
                }
                
                processed_results.append(processed_result)
            
            # Sort by score (descending)
            processed_results.sort(key=lambda x: x['score'], reverse=True)
            
            return processed_results
            
        except Exception as e:
            if attempt < MAX_RETRIES - 1:
                print(f"Error in Exa search (attempt {attempt+1}): {str(e)}")
                time.sleep(RETRY_DELAY * (2 ** attempt))
            else:
                raise Exception(f"Failed to search for evidence: {str(e)}")
            
def search_evidence_batch(queries):
    """
    Search for evidence across multiple queries in parallel
    
    Args:
        queries (list): List of search queries
        
    Returns:
        list: List of search results for each query
    """
    if not queries:
        return []
    
    # Deduplicate queries to avoid redundant searches
    unique_queries = list(set(queries))
    
    # Process searches in parallel
    results_dict = {}
    
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(len(unique_queries), MAX_CONCURRENT_SEARCHES)) as executor:
        # Submit all searches
        future_to_query = {executor.submit(search_evidence, query): query for query in unique_queries}
        
        # Collect results as they complete
        for future in concurrent.futures.as_completed(future_to_query):
            query = future_to_query[future]
            try:
                results = future.result()
                results_dict[query] = results
            except Exception as e:
                print(f"Error searching for '{query}': {str(e)}")
                results_dict[query] = []
    
    # Map results back to original query order
    results = [results_dict.get(query, []) for query in queries]
    
    return results

def summarize_text(text, max_length=1500):
    """
    Summarize long text using OpenAI
    Truncates text if necessary to avoid token limits
    """
    # Truncate text if it's too long to avoid token limits
    if len(text) > max_length:
        text = text[:max_length] + "..."
    
    system_message = "You are an expert at summarizing text concisely while preserving key facts."
    
    prompt = f"""Summarize the following text, focusing on factual information and key points:

{text}

Provide a concise summary in 2-3 sentences. Focus only on the factual content without adding opinions."""

    try:
        response = call_openai_api("gpt-3.5-turbo", [
            {"role": "system", "content": system_message},
            {"role": "user", "content": prompt}
        ], temperature=0.3, max_tokens=150)
        
        return response['choices'][0]['message']['content']
    except Exception as e:
        print(f"Error summarizing text: {str(e)}")
        # Fall back to a simple truncation
        return text[:200] + "..."