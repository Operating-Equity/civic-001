import requests
import json
import re
import time
from flask import current_app

MAX_RETRIES = 3
INITIAL_RETRY_DELAY = 1  # 1 second

def evaluate_with_anthropic(statement, context=""):
    """
    Evaluate a claim for factual accuracy using Anthropic's Claude API
    Returns a structured analysis including classification, confidence score, and supporting facts
    """
    api_key = current_app.config.get('ANTHROPIC_API_KEY')
    if not api_key:
        print("[ANTHROPIC] Warning: Anthropic API key not configured in environment variables")
        return {
            "statement": statement,
            "classification": "UNVERIFIED",
            "confidence": 0,
            "supportingFacts": "Unable to evaluate: Anthropic API key not configured. Please add ANTHROPIC_API_KEY to your environment variables.",
            "model": "Anthropic (Unconfigured)"
        }
        
    headers = {
        "x-api-key": api_key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
    }
    
    system_prompt = "You are tasked with evaluating the truthfulness of statements using a rigorous, first-principles approach. Bias is unacceptable in any form."
    
    user_prompt = f"""You are tasked with evaluating the truthfulness of a statement using a rigorous, first-principles approach. Follow these steps systematically:

### Statement to evaluate: "{statement}"

### Context:
{context}

Respond ONLY with a JSON object in this exact format:
{{
  "classification": "TRUE/FALSE/UNVERIFIED",
  "confidence": <number between 0-100>,
  "supportingFacts": "1. Definitions:\\n<key terms and neutral definitions>\\n\\n2. Principles:\\n<applied principles and frameworks>\\n\\n3. Evidence:\\n<credibility evaluation and key facts>\\n\\n4. Analysis:\\n<step-by-step reasoning>\\n\\n5. Conclusion:\\n<final determination with detailed reasoning>\\n\\n6. Confidence:\\n<score explanation and uncertainty factors>"
}}"""

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
            response = requests.post(
                "https://api.anthropic.com/v1/messages",
                headers=headers,
                json=payload
            )
            
            if response.status_code == 529:  # Rate limit or service busy
                retry_delay = INITIAL_RETRY_DELAY * (2 ** attempt)
                print(f"Anthropic API busy, retrying in {retry_delay}s (attempt {attempt+1}/{MAX_RETRIES})")
                time.sleep(retry_delay)
                continue
                
            elif response.status_code != 200:
                raise Exception(f"Anthropic API error: {response.status_code} - {response.text}")
            
            # Parse the response
            result = response.json()
            
            # Extract the content from the response
            content = result.get("content", [{}])[0].get("text", "")
            
            # Extract the JSON part from the response
            json_str = extract_json_from_text(content)
            
            # Parse the JSON
            analysis = json.loads(json_str)
            
            # Validate the structure
            if not validate_anthropic_response(analysis):
                raise Exception("Invalid response format from Anthropic")
                
            # Return the structured data
            return {
                "statement": statement,
                "classification": analysis["classification"],
                "confidence": analysis["confidence"],
                "supportingFacts": analysis["supportingFacts"],
                "model": "Anthropic"
            }
            
        except Exception as e:
            if attempt == MAX_RETRIES - 1:
                # Return a fallback response on final failure
                return {
                    "statement": statement,
                    "classification": "UNVERIFIED",
                    "confidence": 0,
                    "supportingFacts": f"Error performing analysis with Anthropic: {str(e)}",
                    "model": "Anthropic"
                }
            else:
                # Retry with exponential backoff
                retry_delay = INITIAL_RETRY_DELAY * (2 ** attempt)
                print(f"Error calling Anthropic API, retrying in {retry_delay}s: {str(e)}")
                time.sleep(retry_delay)

def extract_json_from_text(text):
    """Extract JSON object from response text"""
    try:
        # First try to find JSON between the most outer curly braces
        match = re.search(r'{[^{}]*(?:{[^{}]*})*[^{}]*}', text)
        if match:
            # Test if the extracted text is valid JSON
            json_str = match.group(0)
            json.loads(json_str)  # This will raise an exception if not valid JSON
            return json_str
        
        # If no valid JSON found with regex, fall back to basic extraction
        start_index = text.find('{')
        end_index = text.rfind('}')
        
        if start_index != -1 and end_index != -1 and end_index > start_index:
            json_str = text[start_index:end_index+1]
            json.loads(json_str)  # Validate
            return json_str
        
        raise Exception("No valid JSON found in response")
    except Exception as e:
        raise Exception(f"Error extracting JSON: {str(e)}")

def validate_anthropic_response(response):
    """Validate the structure of the Anthropic response"""
    try:
        # Check basic structure
        if not isinstance(response, dict):
            return False
        
        # Check required fields
        if not all(key in response for key in ["classification", "confidence", "supportingFacts"]):
            return False
        
        # Validate classification values
        if response["classification"] not in ["TRUE", "FALSE", "UNVERIFIED"]:
            return False
        
        # Validate confidence (0-100)
        if not isinstance(response["confidence"], (int, float)) or response["confidence"] < 0 or response["confidence"] > 100:
            return False
        
        # Validate supporting facts is a string
        if not isinstance(response["supportingFacts"], str):
            return False
        
        # Check if supporting facts has the expected structure
        required_sections = [
            "1. Definitions:", 
            "2. Principles:", 
            "3. Evidence:", 
            "4. Analysis:", 
            "5. Conclusion:"
        ]
        
        for section in required_sections:
            if section not in response["supportingFacts"]:
                # Not a strict requirement, but helpful for consistent formatting
                print(f"Warning: Missing section '{section}' in Anthropic response")
        
        return True
    except Exception as e:
        print(f"Error validating Anthropic response: {str(e)}")
        return False
