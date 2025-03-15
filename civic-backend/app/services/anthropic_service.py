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

Respond ONLY with a JSON object in this exact format (with no additional text before or after):
{{
  "classification": "TRUE/FALSE/UNVERIFIED",
  "confidence": 50,
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
                json=payload,
                timeout=30  # Add timeout to prevent hanging requests
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
            
            # Clean the content by removing control characters
            content = re.sub(r'[\x00-\x1F\x7F]', '', content)
            content = content.strip()
            
            # Extract the JSON part from the response
            json_str = extract_json_from_text(content)
            
            if not json_str:
                raise Exception("Unable to extract valid JSON from Anthropic response")
            
            # Parse the JSON
            analysis = json.loads(json_str)
            
            # Validate the structure
            if not validate_anthropic_response(analysis):
                print("[ANTHROPIC] Response validation failed, adding default fields")
                # Add missing fields with defaults instead of failing
                if "classification" not in analysis:
                    analysis["classification"] = "UNVERIFIED"
                if "confidence" not in analysis:
                    analysis["confidence"] = 50
                if "supportingFacts" not in analysis:
                    analysis["supportingFacts"] = content
                
            # Return the structured data
            print("[ANTHROPIC] Successfully processed response")
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
                print(f"[ANTHROPIC] All retries failed: {str(e)}")
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
    """Extract JSON object from response text using multiple techniques"""
    try:
        # Remove any backslashes that could be escaping quotes
        text = text.replace('\\', '')
        
        # Method 1: Find the JSON between the most outer curly braces
        json_pattern = r'({[\s\S]*})'
        matches = re.findall(json_pattern, text)
        
        for match in matches:
            try:
                # Test if the extracted text is valid JSON
                cleaned_match = re.sub(r'[\x00-\x1F\x7F]', '', match)
                json.loads(cleaned_match)
                return cleaned_match
            except json.JSONDecodeError:
                continue
        
        # Method 2: Find the largest substring that could be valid JSON
        start_index = text.find('{')
        end_index = text.rfind('}')
        
        if start_index != -1 and end_index != -1 and end_index > start_index:
            json_str = text[start_index:end_index+1]
            try:
                cleaned_json = re.sub(r'[\x00-\x1F\x7F]', '', json_str)
                json.loads(cleaned_json)
                return cleaned_json
            except json.JSONDecodeError:
                pass
        
        # Method 3: Find any valid JSON in the text by trying successive substrings
        for i in range(len(text)):
            if text[i] == '{':
                for j in range(len(text) - 1, i, -1):
                    if text[j] == '}':
                        try:
                            substring = text[i:j+1]
                            cleaned_substring = re.sub(r'[\x00-\x1F\x7F]', '', substring)
                            json.loads(cleaned_substring)
                            return cleaned_substring
                        except json.JSONDecodeError:
                            continue
        
        # Method 4: If all else fails, try to construct a minimal valid JSON
        print("[ANTHROPIC] No valid JSON found, constructing fallback JSON")
        # Extract possible values for fallback JSON
        class_match = re.search(r'classification["\s:]+([A-Z]+)', text, re.IGNORECASE)
        classification = class_match.group(1) if class_match else "UNVERIFIED"
        
        confidence_match = re.search(r'confidence["\s:]+(\d+)', text)
        confidence = confidence_match.group(1) if confidence_match else "50"
        
        # Create a fallback JSON string
        fallback_json = '{{"classification":"{0}","confidence":{1},"supportingFacts":"Unable to parse complete analysis"}}'.format(
            classification, confidence
        )
        
        return fallback_json
        
    except Exception as e:
        print(f"[ANTHROPIC] Error in JSON extraction: {str(e)}")
        return None

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
        
        # Not a strict requirement anymore, just log missing sections
        for section in required_sections:
            if section not in response["supportingFacts"]:
                print(f"[ANTHROPIC] Warning: Missing section '{section}' in response")
        
        return True
    except Exception as e:
        print(f"[ANTHROPIC] Error validating response: {str(e)}")
        return False