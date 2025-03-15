import requests
import json
import re
import time
import logging
import random
from typing import Dict, Any, Optional
from flask import current_app

# Set up logging
logger = logging.getLogger(__name__)

MAX_RETRIES = 3
RETRY_DELAY = 1  # 1 second
REQUEST_TIMEOUT = 30  # seconds

def evaluate_with_perplexity(claim: str, context: str = "", model: str = "sonar-reasoning-pro") -> Dict[str, Any]:
    """
    Evaluate a claim for factual accuracy using Perplexity API
    Returns a structured analysis including classification, confidence score, and supporting facts
    
    Args:
        claim: The claim to evaluate
        context: Additional context to help with evaluation
        model: The Perplexity model to use
        
    Returns:
        Dict containing the evaluation results
    """
    # Check for cached response (we'll add caching later)
    
    api_key = current_app.config.get('PERPLEXITY_API_KEY')
    if not api_key:
        logger.warning("[PERPLEXITY] Warning: Perplexity API key not configured in environment variables")
        result = {
            "statement": claim,
            "classification": "UNVERIFIED",
            "confidence": 0,
            "supportingFacts": "Unable to evaluate: Perplexity API key not configured. Please add PERPLEXITY_API_KEY to your environment variables.",
            "model": "Perplexity (Unconfigured)"
        }
        return result
    
    # Prepare request headers
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    
    # Improved system prompt with structured output requirement
    system_message = "You are tasked with evaluating the truthfulness of statements using a rigorous, first-principles approach."
    
    # User prompt with explicit JSON structure requirements
    user_message = f'''Evaluate this claim: "{claim}".

### Step 1: Establish First Principles
- Identify the logical, scientific, or legal principles governing the evaluation of the claim.

### Step 2: Assess Evidence and Credibility
- Evaluate the credibility of sources using these criteria:
  - Transparency: Does the source provide evidence or citations?
  - Evidence-Based: Are the claims independently verifiable?
  - Independence: Is the source free of conflicts of interest or bias?
  - Track Record: Does the source have a reliable history?

### Step 3: Analyze Step-by-Step
- Break down the claim into logical steps.
- Examine the consistency of evidence with established principles.
- Highlight any alternative interpretations or areas of uncertainty.

### Step 4: Conclude and Rate Confidence
- Provide a conclusion (True/False/Uncertain) based on the analysis.
- Assign a confidence score (0–100%) and explain any uncertainty or limitations.

Context information:
{context}

IMPORTANT: Format your response EXACTLY as a valid JSON object with this structure.
You must avoid any explanation outside the JSON and return ONLY the raw JSON:

{{
  "statement": "the exact claim being evaluated",
  "classification": "TRUE/FALSE/UNVERIFIED",
  "confidence": 50,
  "fullAnalysis": "A detailed explanation that combines all available evidence",
  "researchData": {{
    "facts": [
      {{
        "fact": "Specific fact found during research",
        "source": "Citation or URL for the fact"
      }}
    ]
  }}
}}'''

    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system_message},
            {"role": "user", "content": user_message}
        ],
        "temperature": 0.2,
        "top_p": 0.9,
        "search_domain_filter": ["perplexity.ai"],
        "return_images": False,
        "return_related_questions": False,
        "search_recency_filter": "month",
        "top_k": 0,
        "stream": False,
        "presence_penalty": 0,
        "frequency_penalty": 1,
        "search": True
    }
    
    # Implement retry logic with exponential backoff
    for attempt in range(MAX_RETRIES):
        try:
            logger.info(f"[PERPLEXITY] Attempt {attempt + 1}/{MAX_RETRIES} to evaluate claim")
            
            # Make the API request with timeout
            response = requests.post(
                "https://api.perplexity.ai/chat/completions",
                headers=headers,
                json=payload,
                timeout=REQUEST_TIMEOUT
            )
            
            # Handle rate limiting
            if response.status_code == 429:
                # Exponential backoff with jitter
                wait_time = RETRY_DELAY * (2 ** attempt) * (0.5 + 0.5 * (0.8 + 0.4 * random.random()))
                logger.warning(f"[PERPLEXITY] Rate limited, retrying in {wait_time:.1f}s")
                time.sleep(wait_time)
                continue
                
            if response.status_code != 200:
                error_message = f"API error: {response.status_code} - {response.text}"
                logger.error(f"[PERPLEXITY] {error_message}")
                
                if attempt < MAX_RETRIES - 1:
                    # Exponential backoff for server errors
                    wait_time = RETRY_DELAY * (2 ** attempt)
                    time.sleep(wait_time)
                    continue
                    
                # On final attempt, return a fallback result
                result = {
                    "statement": claim,
                    "classification": "UNVERIFIED",
                    "confidence": 0,
                    "supportingFacts": f"Error performing analysis with Perplexity: {error_message}",
                    "model": model
                }
                return result
                
            # Process successful response
            data = response.json()
            content = data["choices"][0]["message"]["content"]
            
            # Attempt to parse the JSON response with robust error handling
            parsed_result = extract_json_with_fallback(content, claim, model)
            
            # Ensure required fields are present with defaults
            result = normalize_response(parsed_result, claim, model)
            
            logger.info("[PERPLEXITY] Successfully processed response")
            
            return result
            
        except Exception as e:
            logger.error(f"[PERPLEXITY] Error on attempt {attempt + 1}: {str(e)}")
            
            if attempt < MAX_RETRIES - 1:
                # Exponential backoff
                wait_time = RETRY_DELAY * (2 ** attempt)
                time.sleep(wait_time)
            else:
                # Return fallback on final failure
                result = {
                    "statement": claim,
                    "classification": "UNVERIFIED",
                    "confidence": 0,
                    "supportingFacts": f"Error performing analysis with Perplexity: {str(e)}",
                    "model": model
                }
                return result

def extract_json_with_fallback(content: str, claim: str, model: str) -> Dict[str, Any]:
    """
    Extract JSON from the API response with multiple fallback strategies
    
    Args:
        content: The raw API response content
        claim: The original claim (for fallback)
        model: The model name
        
    Returns:
        Dictionary of parsed content or fallback values
    """
    # Clean the content
    clean_content = re.sub(r'[\x00-\x1F\x7F]', '', content.strip())
    
    # Multiple extraction strategies
    strategies = [
        # Strategy 1: Direct JSON parsing
        lambda text: json.loads(text),
        
        # Strategy 2: Find JSON between markers
        lambda text: json.loads(re.search(r'({[\s\S]*})', text).group(1)),
        
        # Strategy 3: Extract just the JSON block with regex
        lambda text: json.loads(re.search(r'```(?:json)?\s*({[\s\S]*?})\s*```', text).group(1)),
        
        # Strategy 4: Search for valid JSON braces
        lambda text: find_json_object(text)
    ]
    
    # Try each strategy in order
    for i, strategy in enumerate(strategies):
        try:
            logger.debug(f"[PERPLEXITY] Trying JSON extraction strategy {i+1}")
            return strategy(clean_content)
        except (json.JSONDecodeError, AttributeError, ValueError, IndexError) as e:
            logger.debug(f"[PERPLEXITY] Strategy {i+1} failed: {str(e)}")
            continue
    
    # If all strategies fail, extract classification and build fallback
    logger.warning("[PERPLEXITY] All JSON extraction strategies failed, using text extraction fallback")
    return extract_classification_from_text(clean_content, claim, model)

def normalize_response(parsed: Dict[str, Any], claim: str, model: str) -> Dict[str, Any]:
    """
    Ensure the response has all required fields with valid values
    
    Args:
        parsed: The parsed response (possibly incomplete)
        claim: The original claim
        model: The model name
        
    Returns:
        Complete, normalized response dictionary
    """
    # Default values for missing fields
    defaults = {
        "statement": claim,
        "classification": "UNVERIFIED",
        "confidence": 50,
        "supportingFacts": "No detailed analysis available.",
        "model": model
    }
    
    # Prepare normalized result with defaults
    result = defaults.copy()
    
    # Update with parsed values where available
    if parsed:
        # Copy basic fields
        for key in ["statement", "classification", "confidence"]:
            if key in parsed and parsed[key] is not None:
                result[key] = parsed[key]
        
        # Normalize classification to expected format
        if result["classification"] not in ["TRUE", "FALSE", "UNVERIFIED"]:
            # Convert from "True"/"False" to "TRUE"/"FALSE" if needed
            norm_class = result["classification"].upper()
            if norm_class in ["TRUE", "FALSE"]:
                result["classification"] = norm_class
            # Convert "Uncertain" or other values to "UNVERIFIED"
            else:
                result["classification"] = "UNVERIFIED"
                
        # Extract supporting facts from fullAnalysis or other fields
        if "fullAnalysis" in parsed and parsed["fullAnalysis"]:
            result["supportingFacts"] = parsed["fullAnalysis"]
        
        # Add detailed analysis if available
        result["detailedAnalysis"] = {
            "evidence": parsed.get("researchData", {}).get("facts", []),
            "keyTerms": [],
            "thinking": [],
            "analysis": parsed.get("fullAnalysis", "No detailed analysis available."),
            "conclusion": parsed.get("fullAnalysis", "No conclusion available.")
        }
    
    return result

def find_json_object(text: str) -> Dict[str, Any]:
    """
    Find the first complete JSON object in a string
    
    Args:
        text: The text to search
        
    Returns:
        Parsed JSON object
        
    Raises:
        ValueError: If no valid JSON object found
    """
    # Find the first opening curly brace
    start = text.find('{')
    if start == -1:
        raise ValueError("No JSON object found")
    
    # Track open and close braces to find the matching closing brace
    depth = 0
    for i in range(start, len(text)):
        if text[i] == '{':
            depth += 1
        elif text[i] == '}':
            depth -= 1
            
        # When we get back to depth 0, we've found the complete object
        if depth == 0:
            potential_json = text[start:i+1]
            # Try to parse it
            return json.loads(potential_json)
    
    raise ValueError("Incomplete JSON object")

def extract_classification_from_text(text: str, claim: str, model: str) -> Dict[str, Any]:
    """
    Extract classification and confidence from text when JSON parsing fails
    
    Args:
        text: The API response text
        claim: The original claim
        model: The model name
        
    Returns:
        Dictionary with extracted information
    """
    # Default fallback
    result = {
        "statement": claim,
        "classification": "UNVERIFIED",
        "confidence": 50,
        "fullAnalysis": text
    }
    
    # Look for classification indicators
    if re.search(r'\b(true|correct|accurate|verified)\b', text.lower()):
        result["classification"] = "TRUE"
    elif re.search(r'\b(false|incorrect|inaccurate)\b', text.lower()):
        result["classification"] = "FALSE"
    
    # Look for confidence percentage
    confidence_match = re.search(r'confidence:?\s*(\d+)%?', text.lower())
    if confidence_match:
        result["confidence"] = int(confidence_match.group(1))
    
    # Try to extract facts as a list
    facts = []
    fact_matches = re.finditer(r'(?:Fact|Evidence)\s*\d*:?\s*(.*?)(?=(?:Fact|Evidence)\s*\d*:|$)', text, re.DOTALL)
    for match in fact_matches:
        fact_text = match.group(1).strip()
        if fact_text:
            facts.append({"fact": fact_text, "source": "Text extraction"})
    
    if facts:
        result["researchData"] = {"facts": facts}
    
    return result