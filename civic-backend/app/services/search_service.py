import requests
import json
import time
from flask import current_app
from app.services.openai_service import call_openai_api

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
    Search for evidence related to a query using Exa.ai
    Returns a list of search results
    """
    api_key = current_app.config.get('EXA_API_KEY')
    if not api_key:
        raise Exception("Exa API key not configured")
        
    headers = {
        'Content-Type': 'application/json',
        'Authorization': f'Bearer {api_key}',
        'Accept': 'application/json'
    }
    
    payload = {
        "query": query,
        "numResults": 25,
        "useAutoprompt": True,
        "searchDepth": "advanced",
        "highlights": True,
        "recencyDays": 365,
        "similarityThreshold": 0.7,
        "sortBy": "date"
    }
    
    for attempt in range(MAX_RETRIES):
        try:
            response = requests.post(
                'https://api.exa.ai/discuss/search',
                headers=headers,
                json=payload
            )
            
            if response.status_code != 200:
                raise Exception(f"Exa.ai API error: {response.status_code} - {response.text}")
                
            data = response.json()
            results = data.get('results', [])
            
            # Filter out disqualified sources
            filtered_results = [
                result for result in results
                if not any(source.lower() in result.get('title', '').lower() 
                          for source in DISQUALIFIED_SOURCES)
            ]
            
            # Process results to add summaries
            processed_results = []
            for result in filtered_results:
                # Add a summary using text snippet if full text is not available
                if 'text' not in result or not result['text']:
                    result['text'] = result.get('snippet', '')
                    
                # Generate a summary if we have enough text
                if len(result.get('text', '')) > 200:
                    try:
                        summary = summarize_text(result['text'])
                        result['summary'] = summary
                    except Exception as e:
                        print(f"Error generating summary: {str(e)}")
                        result['summary'] = result.get('snippet', '')[:200] + '...'
                else:
                    result['summary'] = result.get('text', '')[:200]
                
                # Clean up and standardize fields
                processed_result = {
                    'title': result.get('title', 'Untitled'),
                    'url': result.get('url', ''),
                    'publishedDate': result.get('publishedDate', ''),
                    'author': result.get('author', 'Unknown'),
                    'score': result.get('score', 0),
                    'text': result.get('text', ''),
                    'summary': result.get('summary', '')
                }
                
                processed_results.append(processed_result)
            
            # Sort by score (descending)
            processed_results.sort(key=lambda x: x['score'], reverse=True)
            
            return processed_results
            
        except Exception as e:
            if attempt < MAX_RETRIES - 1:
                print(f"Error in Exa.ai search (attempt {attempt+1}): {str(e)}")
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
