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
        raise Exception("Perplexity API key not configured")
        
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

Respond in this exact JSON format:
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
  "confidence": percentage between 0-100,
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
        "response_format": None,
        "search": True
    }
    
    for attempt in range(MAX_RETRIES):
        try:
            response = requests.post(
                "https://api.perplexity.ai/chat/completions",
                headers=headers,
                json=payload
            )
            
            if response.status_code != 200:
                raise Exception(f"Perplexity API error: {response.status_code} - {response.text}")
                
            data = response.json()
            result = data["choices"][0]["message"]["content"]
            
            # Parse the JSON response
            try:
                # First attempt: direct JSON parse
                parsed_result = json.loads(result)
            except json.JSONDecodeError:
                # Second attempt: try to extract JSON if there's additional text
                json_match = re.search(r'{[\s\S]*}', result)
                if json_match:
                    parsed_result = json.loads(json_match.group(0))
                else:
                    raise Exception("No valid JSON found in response")
            
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
            return {
                "statement": parsed_result["statement"],
                "classification": parsed_result["classification"],
                "confidence": parsed_result["confidence"],
                "supportingFacts": parsed_result["fullAnalysis"],
                "detailedAnalysis": {
                    "evidence": parsed_result["researchData"]["facts"],
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
                return {
                    "statement": claim,
                    "classification": "UNVERIFIED",
                    "confidence": 0,
                    "supportingFacts": f"Error performing analysis with Perplexity: {str(e)}",
                    "model": model
                }
