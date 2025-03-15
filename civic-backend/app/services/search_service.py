import time
import json
from flask import current_app
from app.services.openai_service import call_openai_api
from exa_py import Exa

MAX_RETRIES = 3
RETRY_DELAY = 1  # 1 second

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
    system_message = "You are an expert in crafting search queries."
    
    prompt = f"""Given the following:

{video_title and f"Video Title: {video_title}" or ""}
- Claim: {claim}
- Context: {context}
- Validation Potential: {validation_potential}

Generate three well-structured Google search queries to verify or debunk the claim by:

1. Incorporating key terms from the claim and context while ensuring clarity and relevance.
2. Following the validation potential instructions to focus on official reports, credible sources, timelines, and public records.
3. Crafting search queries to prioritize government websites and official statements that are empirical statements of fact.
4. Crafting one search term that explicitly looks for bias in reporting.
5. All search terms are up to 15 words.
Each search query should be optimized to return reliable and comprehensive information related to the empirical claim but should never specify a specific news source."""

    try:
        response = call_openai_api("gpt-4o", [
            {"role": "system", "content": system_message},
            {"role": "user", "content": prompt}
        ], temperature=0.7)
        
        content = response['choices'][0]['message']['content']
        
        # Extract queries as a list of strings
        keywords = [
            line.strip() for line in content.split('\n')
            if line.strip() and not line.strip().startswith('#')
        ]
        
        return keywords
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
            # Use search_and_contents method to get both search results and their text content
            response = exa.search_and_contents(
                query=query,
                text=True,               # Include full text
                highlights=True,         # Include relevant highlights
                num_results=25,
                use_autoprompt=True,
                # The SDK handles the recency and sorting automatically
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