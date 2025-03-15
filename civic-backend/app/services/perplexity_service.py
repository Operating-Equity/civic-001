import requests
import json
import re
import time
from flask import current_app

MAX_RETRIES = 3
RETRY_DELAY = 1  # 1 second

def evaluate_with_perplexity(claim, context="", model="sonar-reasoning-pro"):
    """
    Evaluate a claim for factual accuracy using Perplexity API
    Returns a structured analysis including classification, confidence score, and supporting facts
    """
    api_key = current_app.config.get('PERPLEXITY_API_KEY')
    if not api_key:
        print("[PERPLEXITY] Warning: Perplexity API key not configured in environment variables")
        return {
            "statement": claim,
            "classification": "UNVERIFIED",
            "confidence": 0,
            "supportingFacts": "Unable to evaluate: Perplexity API key not configured. Please add PERPLEXITY_API_KEY to your environment variables.",
            "model": "Perplexity (Unconfigured)"
        }
        
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    
    system_message = "You are tasked with evaluating the truthfulness of statements using a rigorous, first-principles approach."
    
    user_message = f"""Evaluate this claim: "{claim}".

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

IMPORTANT: Your response must be a valid JSON object with the following structure. 
Do not include any text, markdown formatting, or explanations outside of this JSON object.
Just return the raw JSON without any code blocks:

{{
  "statement": "the exact claim being evaluated",
  "classification": "TRUE/FALSE/UNVERIFIED",
  "researchData": {{
    "facts": [
      {{
        "fact": "A specific fact found during research",
        "source": "URL or citation for the fact"
      }}
    ],
    "context": "Detailed background information and context",
    "citations": ["array of citation URLs"]
  }},
  "confidence": 50,
  "fullAnalysis": "A detailed explanation that combines all available evidence"
}}"""

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
        # Note: Perplexity doesn't support the same response_format parameter as OpenAI
        "search": True
    }
    
    for attempt in range(MAX_RETRIES):
        try:
            response = requests.post(
                "https://api.perplexity.ai/chat/completions",
                headers=headers,
                json=payload,
                timeout=30  # Add timeout to prevent hanging requests
            )
            
            if response.status_code != 200:
                raise Exception(f"Perplexity API error: {response.status_code} - {response.text}")
                
            data = response.json()
            result = data["choices"][0]["message"]["content"]
            
            # Parse the JSON response
            parsed_result = None
            
            try:
                # First attempt: clean the string and parse
                clean_result = result.strip()
                # Replace invalid control characters that might be present
                clean_result = re.sub(r'[\x00-\x1F\x7F]', '', clean_result)
                parsed_result = json.loads(clean_result)
            except json.JSONDecodeError as e:
                print(f"[PERPLEXITY] JSON parsing error: {str(e)}")
                try:
                    # Second attempt: try to extract JSON if there's additional text
                    json_match = re.search(r'({[\s\S]*})', clean_result)
                    if json_match:
                        json_str = json_match.group(1)
                        # Further clean the extracted JSON
                        json_str = re.sub(r'[\x00-\x1F\x7F]', '', json_str)
                        parsed_result = json.loads(json_str)
                    else:
                        raise Exception("No valid JSON found in response")
                except Exception as inner_e:
                    print(f"[PERPLEXITY] Second JSON parsing attempt failed: {str(inner_e)}")
                    # If we're on the last retry, return a fallback structure
                    if attempt == MAX_RETRIES - 1:
                        # Create a basic structure from the text
                        parsed_result = {
                            "statement": claim,
                            "classification": "UNVERIFIED",
                            "confidence": 50,
                            "researchData": {
                                "facts": [],
                                "context": context,
                                "citations": []
                            },
                            "fullAnalysis": result
                        }
                    else:
                        # Try again
                        time.sleep(RETRY_DELAY * (2 ** attempt))
                        continue
            
            # Ensure required fields are present with defaults
            if "statement" not in parsed_result:
                parsed_result["statement"] = claim
                
            if "classification" not in parsed_result:
                parsed_result["classification"] = "UNVERIFIED"
                
            if "confidence" not in parsed_result:
                parsed_result["confidence"] = 50
                
            if "researchData" not in parsed_result:
                parsed_result["researchData"] = {
                    "facts": [],
                    "context": "",
                    "citations": []
                }
                
            if "fullAnalysis" not in parsed_result:
                parsed_result["fullAnalysis"] = result
            
            # Convert to standard response format
            print("[PERPLEXITY] Successfully parsed response")
            return {
                "statement": parsed_result["statement"],
                "classification": parsed_result["classification"],
                "confidence": parsed_result["confidence"],
                "supportingFacts": parsed_result["fullAnalysis"],
                "detailedAnalysis": {
                    "evidence": parsed_result.get("researchData", {}).get("facts", []),
                    "keyTerms": [],
                    "thinking": [],
                    "definitions": [],
                    "principles": [],
                    "logicalAnalysis": [],
                    "evidenceAssessment": [],
                    "analysis": parsed_result["fullAnalysis"],
                    "conclusion": parsed_result["fullAnalysis"]
                },
                "model": model
            }
            
        except Exception as e:
            if attempt < MAX_RETRIES - 1:
                print(f"Error in Perplexity API call (attempt {attempt+1}): {str(e)}")
                time.sleep(RETRY_DELAY * (2 ** attempt))
            else:
                # Return fallback response on final failure
                print(f"[PERPLEXITY] All retries failed: {str(e)}")
                return {
                    "statement": claim,
                    "classification": "UNVERIFIED",
                    "confidence": 0,
                    "supportingFacts": f"Error performing analysis with Perplexity: {str(e)}",
                    "model": model
                }