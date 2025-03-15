import requests
import json
import re
import time
import logging
import random
from typing import Dict, Any, Optional, List
from flask import current_app

# Set up logging
logger = logging.getLogger(__name__)

MAX_RETRIES = 3
INITIAL_RETRY_DELAY = 1  # 1 second
REQUEST_TIMEOUT = 30  # seconds

def evaluate_with_anthropic(statement: str, context: str = "") -> Dict[str, Any]:
    """
    Evaluate a claim for factual accuracy using Anthropic's Claude API
    Returns a structured analysis including classification, confidence score, and supporting facts
    
    Args:
        statement: The statement to evaluate
        context: Additional context for evaluation
        
    Returns:
        Dict containing evaluation results
    """
    api_key = current_app.config.get('ANTHROPIC_API_KEY')
    if not api_key:
        logger.warning("[ANTHROPIC] Warning: Anthropic API key not configured in environment variables")
        result = {
            "statement": statement,
            "classification": "UNVERIFIED",
            "confidence": 0,
            "supportingFacts": "Unable to evaluate: Anthropic API key not configured. Please add ANTHROPIC_API_KEY to your environment variables.",
            "model": "Anthropic (Unconfigured)"
        }
        return result
    
    # Prepare headers
    headers = {
        "x-api-key": api_key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
    }
    
    # Improved system prompt
    system_prompt = """You are tasked with evaluating the truthfulness of statements using a rigorous, first-principles approach. 
    You must produce a valid JSON response in the exact format requested and avoid any text outside the JSON structure."""
    
    # User prompt with improved formatting instructions
    user_prompt = f"""Evaluate this statement for truthfulness: "{statement}"

Context information:
{context}

Analyze thoroughly and respond with ONLY a JSON object in this exact format:
{{
  "classification": "TRUE/FALSE/UNVERIFIED",
  "confidence": 50,
  "supportingFacts": "1. Definitions:\\n<key terms defined>\\n\\n2. Principles:\\n<principles applied>\\n\\n3. Evidence:\\n<evidence analysis>\\n\\n4. Analysis:\\n<step-by-step reasoning>\\n\\n5. Conclusion:\\n<final determination with reasoning>"
}}

The JSON must be valid with no extra text, markdown formatting, or explanations outside the JSON structure."""

    payload = {
        "model": "claude-3-opus-20240229",
        "max_tokens": 4096,
        "messages": [
            {"role": "user", "content": user_prompt}
        ],
        "temperature": 0.1
    }
    
    # Add system prompt if specified
    if system_prompt:
        payload["system"] = system_prompt
    
    for attempt in range(MAX_RETRIES):
        try:
            # Log the attempt
            logger.info(f"[ANTHROPIC] Attempt {attempt+1}/{MAX_RETRIES} to evaluate statement")
            
            # Make the API request with timeout
            response = requests.post(
                "https://api.anthropic.com/v1/messages",
                headers=headers,
                json=payload,
                timeout=REQUEST_TIMEOUT
            )
            
            # Handle rate limiting
            if response.status_code == 429 or response.status_code == 529:
                # Exponential backoff with jitter
                retry_delay = INITIAL_RETRY_DELAY * (2 ** attempt) * (0.5 + 0.5 * random.random())
                logger.warning(f"[ANTHROPIC] Rate limited (status: {response.status_code}), retrying in {retry_delay:.1f}s")
                time.sleep(retry_delay)
                continue
                
            if response.status_code != 200:
                error_message = f"API error: {response.status_code} - {response.text}"
                logger.error(f"[ANTHROPIC] {error_message}")
                
                if attempt < MAX_RETRIES - 1:
                    # Exponential backoff for server errors
                    retry_delay = INITIAL_RETRY_DELAY * (2 ** attempt)
                    time.sleep(retry_delay)
                    continue
                
                # On final attempt, return a fallback result
                result = {
                    "statement": statement,
                    "classification": "UNVERIFIED",
                    "confidence": 0,
                    "supportingFacts": f"Error performing analysis with Anthropic: {error_message}",
                    "model": "Anthropic"
                }
                return result
            
            # Process successful response
            api_result = response.json()
            
            # Extract content from the response
            if not api_result.get("content") or not isinstance(api_result["content"], list) or not api_result["content"]:
                raise ValueError("Invalid API response structure: missing or empty content field")
            
            # Get the first text content
            content_item = next((item for item in api_result["content"] if item.get("type") == "text"), None)
            if not content_item or "text" not in content_item:
                raise ValueError("Invalid API response: missing text content")
            
            content = content_item["text"]
            
            # Clean the content
            content = re.sub(r'[\x00-\x1F\x7F]', '', content).strip()
            
            # Process the content to extract the JSON
            analysis = extract_json_with_fallback(content, statement)
            
            # Validate and normalize the response
            result = normalize_response(analysis, statement)
            
            logger.info("[ANTHROPIC] Successfully processed response")
            return result
            
        except requests.RequestException as e:
            logger.error(f"[ANTHROPIC] Request error on attempt {attempt+1}: {str(e)}")
            
            if attempt < MAX_RETRIES - 1:
                # Exponential backoff
                retry_delay = INITIAL_RETRY_DELAY * (2 ** attempt)
                time.sleep(retry_delay)
            else:
                # Return fallback on final failure
                result = {
                    "statement": statement,
                    "classification": "UNVERIFIED",
                    "confidence": 0,
                    "supportingFacts": f"Error performing analysis with Anthropic: {str(e)}",
                    "model": "Anthropic"
                }
                return result
        except Exception as e:
            logger.error(f"[ANTHROPIC] Error on attempt {attempt+1}: {str(e)}")
            
            if attempt < MAX_RETRIES - 1:
                # Exponential backoff
                retry_delay = INITIAL_RETRY_DELAY * (2 ** attempt)
                time.sleep(retry_delay)
            else:
                # Return fallback on final failure
                result = {
                    "statement": statement,
                    "classification": "UNVERIFIED",
                    "confidence": 0,
                    "supportingFacts": f"Error processing Anthropic response: {str(e)}",
                    "model": "Anthropic"
                }
                return result

def extract_json_with_fallback(content: str, statement: str) -> Dict[str, Any]:
    """
    Extract JSON from Anthropic response with multiple fallback strategies
    
    Args:
        content: The raw API response content
        statement: The original statement (for fallback)
        
    Returns:
        Dictionary of parsed content or fallback values
    """
    try:
        # Strategy 1: Direct JSON parsing if the response is clean JSON
        try:
            logger.debug("[ANTHROPIC] Attempting direct JSON parsing")
            return json.loads(content)
        except json.JSONDecodeError:
            pass
        
        # Strategy 2: Find the JSON between code blocks
        json_code_block_match = re.search(r'```(?:json)?\s*({\s*".*})\s*```', content, re.DOTALL)
        if json_code_block_match:
            logger.debug("[ANTHROPIC] Extracting JSON from code block")
            try:
                json_str = json_code_block_match.group(1)
                return json.loads(json_str)
            except json.JSONDecodeError:
                pass
        
        # Strategy 3: Find JSON between curly braces with regex
        logger.debug("[ANTHROPIC] Attempting to extract JSON with regex")
        json_matches = re.findall(r'({(?:[^{}]|(?R))*})', content)
        for json_str in json_matches:
            try:
                return json.loads(json_str)
            except json.JSONDecodeError:
                continue
        
        # Strategy 4: Find the largest substring that could be valid JSON
        logger.debug("[ANTHROPIC] Searching for valid JSON substring")
        start_index = content.find('{')
        end_index = content.rfind('}')
        
        if start_index != -1 and end_index != -1 and end_index > start_index:
            json_str = content[start_index:end_index+1]
            try:
                cleaned_json = re.sub(r'[\x00-\x1F\x7F]', '', json_str)
                return json.loads(cleaned_json)
            except json.JSONDecodeError:
                pass
            
        # Strategy 5: Try to extract a JSON structure using brace matching
        logger.debug("[ANTHROPIC] Attempting brace matching for JSON extraction")
        result = find_json_with_brace_matching(content)
        if result:
            return result
            
        # If all attempts fail, extract classification from text
        logger.warning("[ANTHROPIC] No valid JSON found, constructing fallback JSON")
        
        # Attempt to extract classification and confidence
        return extract_classification_from_text(content, statement)
            
    except Exception as e:
        logger.error(f"[ANTHROPIC] Error in JSON extraction: {str(e)}")
        # Return minimal fallback
        return {
            "classification": "UNVERIFIED",
            "confidence": 50,
            "supportingFacts": content[:1000] # Truncate to reasonable size
        }

def find_json_with_brace_matching(text: str) -> Optional[Dict[str, Any]]:
    """
    Extract JSON using brace matching to handle nested structures
    
    Args:
        text: Input text that might contain JSON
        
    Returns:
        Parsed JSON object or None if not found
    """
    # Find opening brace
    start = text.find('{')
    if start == -1:
        return None
    
    # Track nesting level
    level = 0
    for i in range(start, len(text)):
        if text[i] == '{':
            level += 1
        elif text[i] == '}':
            level -= 1
            
            # When we return to level 0, we've found a complete JSON object
            if level == 0:
                try:
                    json_str = text[start:i+1]
                    return json.loads(json_str)
                except json.JSONDecodeError:
                    # Try more sophisticated cleaning
                    try:
                        # Replace escaped quotes
                        cleaned = json_str.replace('\\"', '"')
                        # Fix common JSON formatting issues
                        cleaned = re.sub(r'("[\w\s]+")(?=:)', r'\1', cleaned) 
                        return json.loads(cleaned)
                    except json.JSONDecodeError:
                        # Continue looking
                        pass
    
    return None

def extract_classification_from_text(text: str, statement: str) -> Dict[str, Any]:
    """
    Extract classification, confidence, and supporting facts from text
    
    Args:
        text: Text to analyze
        statement: Original statement
        
    Returns:
        Dictionary with extracted information
    """
    # Default values
    classification = "UNVERIFIED"
    confidence = 50
    
    # Look for classification markers
    if re.search(r'\b(true|correct|accurate|verifiable)\b', text.lower()):
        classification = "TRUE"
    elif re.search(r'\b(false|incorrect|inaccurate|not accurate)\b', text.lower()):
        classification = "FALSE"
    
    # Look for confidence information
    confidence_match = re.search(r'confidence(?:\s+score)?(?:\s*(?:is|of|\:))?\s*(\d+)%?', text.lower())
    if confidence_match:
        confidence = int(confidence_match.group(1))
    
    # Extract structured sections
    sections = {}
    current_section = None
    section_content = []
    
    for line in text.split('\n'):
        # Check for section headers
        section_match = re.match(r'^(?:\d+\.?\s*)?(?:(\bDefinitions?\b)|(\bPrinciples?\b)|(\bEvidence\b)|(\bAnalysis\b)|(\bConclusion\b))\s*:?', line, re.IGNORECASE)
        
        if section_match:
            # Save previous section
            if current_section and section_content:
                sections[current_section] = '\n'.join(section_content)
                section_content = []
            
            # Determine new section
            for i, name in enumerate(['definitions', 'principles', 'evidence', 'analysis', 'conclusion']):
                if section_match.group(i+1):
                    current_section = name
                    break
        elif current_section:
            # Add content to current section
            section_content.append(line.strip())
    
    # Save the last section
    if current_section and section_content:
        sections[current_section] = '\n'.join(section_content)
    
    # Format supporting facts with available sections
    supporting_facts = []
    
    # Add available sections in a structured format
    if sections.get('definitions'):
        supporting_facts.append("1. Definitions:\n" + sections['definitions'])
    else:
        supporting_facts.append("1. Definitions:\nNo specific definitions provided.")
        
    if sections.get('principles'):
        supporting_facts.append("2. Principles:\n" + sections['principles'])
    else:
        supporting_facts.append("2. Principles:\nNo specific principles provided.")
        
    if sections.get('evidence'):
        supporting_facts.append("3. Evidence:\n" + sections['evidence'])
    else:
        supporting_facts.append("3. Evidence:\nNo specific evidence provided.")
        
    if sections.get('analysis'):
        supporting_facts.append("4. Analysis:\n" + sections['analysis'])
    else:
        supporting_facts.append("4. Analysis:\nNo detailed analysis provided.")
        
    if sections.get('conclusion'):
        supporting_facts.append("5. Conclusion:\n" + sections['conclusion'])
    else:
        supporting_facts.append("5. Conclusion:\nInsufficient information to reach a definitive conclusion.")
    
    # If we have no sections, use the original text
    if not sections:
        supporting_facts = ["Original Response:\n" + text]
    
    return {
        "classification": classification,
        "confidence": confidence,
        "supportingFacts": "\n\n".join(supporting_facts)
    }

def normalize_response(analysis: Dict[str, Any], statement: str) -> Dict[str, Any]:
    """
    Ensure the response has all required fields with valid values
    
    Args:
        analysis: The parsed response (possibly incomplete)
        statement: The original statement
        
    Returns:
        Complete, normalized response dictionary
    """
    # Ensure classification is in the expected format
    classification = analysis.get("classification", "UNVERIFIED")
    if classification not in ["TRUE", "FALSE", "UNVERIFIED"]:
        # Convert to uppercase if it's a case issue
        classification = classification.upper()
        # Handle variations like "True", "Yes", etc.
        if classification in ["TRUE", "CORRECT", "YES", "VERIFIED"]:
            classification = "TRUE"
        elif classification in ["FALSE", "INCORRECT", "NO", "WRONG"]:
            classification = "FALSE"
        else:
            classification = "UNVERIFIED"
    
    # Ensure confidence is an integer between 0-100
    confidence = analysis.get("confidence", 50)
    try:
        confidence = int(confidence)
        confidence = max(0, min(100, confidence))  # Clamp to 0-100
    except (ValueError, TypeError):
        confidence = 50  # Default
    
    # Ensure supporting facts is a string
    supporting_facts = analysis.get("supportingFacts", "")
    if not isinstance(supporting_facts, str):
        supporting_facts = str(supporting_facts)
    
    # Structure the result
    result = {
        "statement": statement,
        "classification": classification,
        "confidence": confidence,
        "supportingFacts": supporting_facts,
        "model": "Anthropic"
    }
    
    return result