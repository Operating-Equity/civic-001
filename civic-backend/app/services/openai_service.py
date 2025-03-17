import requests
import json
import re
import time
import threading
import logging
from flask import current_app

# Set up logging
logger = logging.getLogger(__name__)

# Constants
MAX_RETRIES = 3
BASE_RETRY_DELAY = 1.0  # base delay in seconds
OPENAI_RATE_LIMIT = 10  # maximum requests per minute (conservative)
OPENAI_TIMEOUT = 28  # Just under Gunicorn's default 30-second timeout

# Rate limiter for OpenAI API requests
class OpenAIRateLimiter:
    """
    Rate limiter to ensure API requests don't exceed the specified rate limit.
    Uses a token bucket algorithm to manage request rates.
    """
    def __init__(self, requests_per_minute=10):
        """
        Initialize the rate limiter.
        
        Args:
            requests_per_minute: Maximum number of requests per minute
        """
        self.rate_limit = requests_per_minute / 60.0  # Convert to requests per second
        self.tokens = 1.0  # Start with one token
        self.last_refill = time.time()
        self.lock = threading.Lock()
        
    def wait_for_token(self):
        """
        Wait until a token is available before proceeding.
        Implements the token bucket algorithm with a minimum wait time.
        """
        with self.lock:
            # Refill tokens based on elapsed time
            now = time.time()
            elapsed = now - self.last_refill
            new_tokens = elapsed * self.rate_limit
            
            if new_tokens > 0:
                self.tokens = min(1.0, self.tokens + new_tokens)
                self.last_refill = now
            
            # If no tokens available, calculate wait time
            if self.tokens < 1:
                # Calculate how long until at least one token is available
                wait_time = (1 - self.tokens) / self.rate_limit
                logger.info(f"OpenAI rate limit reached, waiting {wait_time:.2f}s before next request")
                time.sleep(wait_time)
                # After waiting, we should have at least one token
                self.tokens = 1.0
                self.last_refill = time.time()
            
            # Consume a token
            self.tokens -= 1.0
            
            # Always add a small delay between requests
            time.sleep(0.1)

# Global rate limiter instance
openai_rate_limiter = OpenAIRateLimiter(OPENAI_RATE_LIMIT)

def call_openai_api(model, messages, temperature=0.3, max_tokens=None):
    """
    Generic function to call OpenAI API with retries and rate limiting
    """
    api_key = current_app.config.get('OPENAI_API_KEY')
    if not api_key:
        logger.error("[OPENAI] Warning: OpenAI API key not configured in environment variables")
        raise Exception("OpenAI API key not configured. Please add OPENAI_API_KEY to your environment variables.")
        
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json"
    }
    
    payload = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
    }
    
    if max_tokens:
        payload["max_tokens"] = max_tokens
    
    # Use shorter timeout - just under Gunicorn's default 30 seconds
    timeout = OPENAI_TIMEOUT
    
    # Implement retry logic with exponential backoff
    for attempt in range(MAX_RETRIES):
        try:
            # Wait for rate limiter token
            openai_rate_limiter.wait_for_token()
            
            # Make API request with timeout
            logger.info(f"Calling OpenAI API (attempt {attempt+1}/{MAX_RETRIES})")
            response = requests.post(
                "https://api.openai.com/v1/chat/completions",
                headers=headers,
                json=payload,
                timeout=timeout
            )
            
            # Handle different status codes
            if response.status_code == 200:
                return response.json()
            elif response.status_code == 429:
                # Rate limit hit - wait longer before retry
                retry_delay = BASE_RETRY_DELAY * (4 ** attempt)
                logger.warning(f"OpenAI API rate limit exceeded. Waiting {retry_delay}s before retry.")
                time.sleep(retry_delay)
                continue
            elif response.status_code >= 500:
                # Server error - retry with backoff
                retry_delay = BASE_RETRY_DELAY * (2 ** attempt)
                logger.warning(f"OpenAI API server error ({response.status_code}). Waiting {retry_delay}s before retry.")
                time.sleep(retry_delay)
                continue
            else:
                # Other errors - raise exception
                logger.error(f"OpenAI API error: {response.status_code} - {response.text}")
                raise Exception(f"OpenAI API error: {response.status_code} - {response.text}")
                
        except requests.exceptions.Timeout:
            # Handle timeout specially
            logger.warning(f"OpenAI API request timed out after {timeout}s (attempt {attempt+1}/{MAX_RETRIES})")
            if attempt < MAX_RETRIES - 1:
                # Calculate retry delay with exponential backoff
                retry_delay = BASE_RETRY_DELAY * (2 ** attempt)
                logger.info(f"Retrying in {retry_delay}s...")
                time.sleep(retry_delay)
            else:
                logger.error(f"OpenAI API request timed out after {MAX_RETRIES} attempts")
                raise Exception(f"OpenAI API request timed out after {MAX_RETRIES} attempts of {timeout}s each. Please try again later.")
                
        except requests.exceptions.RequestException as e:
            # Handle connection errors
            logger.warning(f"OpenAI API request error: {str(e)} (attempt {attempt+1}/{MAX_RETRIES})")
            if attempt < MAX_RETRIES - 1:
                retry_delay = BASE_RETRY_DELAY * (2 ** attempt)
                logger.info(f"Retrying in {retry_delay}s...")
                time.sleep(retry_delay)
            else:
                logger.error(f"OpenAI API request failed after {MAX_RETRIES} attempts: {str(e)}")
                raise Exception(f"Failed to connect to OpenAI API after {MAX_RETRIES} attempts: {str(e)}")
    
    # This should not be reached due to the exception in the last iteration, but just in case
    raise Exception(f"OpenAI API request failed after {MAX_RETRIES} attempts")

def evaluate_with_openai(statement, context=""):
    """
    Evaluate a claim for factual accuracy using OpenAI
    Returns a structured analysis including classification, confidence score, and supporting facts
    """
    # First check if the API key is available - if not, return a helpful response
    api_key = current_app.config.get('OPENAI_API_KEY')
    if not api_key:
        print("[OPENAI] Warning: OpenAI API key not configured in environment variables")
        return {
            "statement": statement,
            "classification": "UNVERIFIED",
            "confidence": 0,
            "supportingFacts": "Unable to evaluate: OpenAI API key not configured. Please add OPENAI_API_KEY to your environment variables.",
            "model": "OpenAI (Unconfigured)"
        }
    
    system_message = """You are tasked with evaluating the truthfulness of statements using a rigorous, first-principles approach. Bias is unacceptable in any form."""
    
    user_message = f"""You are tasked with evaluating the truthfulness of a statement using a rigorous, first-principles approach. Follow these steps systematically:

### Step 1: Define the Statement
- Identify the key terms in the statement and provide neutral, universally accepted definitions.
- Rephrase the statement into a clear, logical claim.

### Step 2: Establish Principles
- Identify the logical, scientific, legal, economic, or historical principles governing the evaluation of the claim.
- Explicitly state universal or domain-specific principles.

### Step 3: Review Provided Context
{context}

### Step 4: Assess Evidence and Credibility
- Evaluate the credibility of sources using: transparency, evidence-based reasoning, independence, and track record.
- Score each source (1-5) for credibility.
- Reject evidence from sources failing neutrality standards.

### Step 5: Analyze Step-by-Step
- Break down the claim into logical steps.
- Examine consistency with established principles.
- Highlight alternative interpretations or uncertainties.

### Step 6: Conclude and Rate Confidence
- Provide a conclusion (TRUE/FALSE/UNVERIFIED) based on the analysis.
- Assign a confidence score (0–100%) and explain uncertainty factors.

Statement to evaluate: "{statement}"

Format your response with these sections:
1. Definitions
2. Principles
3. Evidence
4. Analysis
5. Conclusion
6. Confidence Score
"""

    try:
        try:
            response = call_openai_api("gpt-4o", [
                {"role": "system", "content": system_message},
                {"role": "user", "content": user_message}
            ], temperature=0.2, max_tokens=2000)
        except Exception as api_error:
            # If the error is related to API key configuration, return a specific response
            if "API key not configured" in str(api_error):
                return {
                    "statement": statement,
                    "classification": "UNVERIFIED",
                    "confidence": 0,
                    "supportingFacts": f"Error: {str(api_error)}",
                    "model": "OpenAI (Unconfigured)"
                }
            # Otherwise re-raise the exception to be caught by the general handler
            raise
        
        content = response['choices'][0]['message']['content']
        
        # Parse the response to extract classification and confidence
        classification = 'UNVERIFIED'
        if re.search(r'\b(true|correct|accurate)\b', content.lower()):
            classification = 'TRUE'
        elif re.search(r'\b(false|incorrect|inaccurate)\b', content.lower()):
            classification = 'FALSE'
            
        # Extract confidence score
        confidence_match = re.search(r'confidence\s+(?:score)?:?\s*(\d+)%?', content.lower())
        confidence = int(confidence_match.group(1)) if confidence_match else 50
        
        # Parse the content into structured sections
        sections = {}
        current_section = None
        
        for line in content.split('\n'):
            # Check for section headers
            section_match = re.match(r'^(?:\d+\.\s*)?(?:(definitions?)|(principles?)|(evidence)|(analysis)|(conclusion)|(confidence))', line.lower())
            if section_match:
                # Determine which section this is
                if section_match.group(1):
                    current_section = 'definitions'
                elif section_match.group(2):
                    current_section = 'principles'
                elif section_match.group(3):
                    current_section = 'evidence'
                elif section_match.group(4):
                    current_section = 'analysis'
                elif section_match.group(5):
                    current_section = 'conclusion'
                elif section_match.group(6):
                    current_section = 'confidence'
                    
                # Initialize the section if it doesn't exist
                if current_section not in sections:
                    sections[current_section] = []
                    
            elif current_section and line.strip():
                # Add content to the current section
                sections[current_section].append(line.strip())
        
        # Create a detailed analysis object
        detailed_analysis = {
            "definitions": sections.get('definitions', []),
            "principles": sections.get('principles', []),
            "evidence": extract_evidence_items(sections.get('evidence', [])),
            "analysis": "\n".join(sections.get('analysis', [])),
            "conclusion": "\n".join(sections.get('conclusion', [])),
        }
        
        return {
            "statement": statement,
            "classification": classification,
            "confidence": confidence,
            "supportingFacts": content,
            "detailedAnalysis": detailed_analysis,
            "model": "OpenAI"
        }
        
    except Exception as e:
        # Return a fallback result if the analysis fails
        return {
            "statement": statement,
            "classification": "UNVERIFIED",
            "confidence": 0,
            "supportingFacts": f"Error performing analysis with OpenAI: {str(e)}",
            "model": "OpenAI"
        }

def extract_evidence_items(evidence_lines):
    """Parse evidence lines into structured fact items"""
    evidence_items = []
    current_fact = ""
    current_source = ""
    
    for line in evidence_lines:
        # Check if this line looks like a new evidence point
        is_new_point = bool(re.match(r'^\d+\.|\*|-', line))
        source_match = re.search(r'Source:\s*(.+)', line)
        
        if source_match:
            # This line contains source information
            if current_fact:
                # Save the previous fact if we have one
                evidence_items.append({
                    "fact": current_fact,
                    "source": current_source or "Not specified"
                })
            current_source = source_match.group(1)
            current_fact = re.sub(r'Source:\s*.+', '', line).strip()
        elif is_new_point and current_fact:
            # This is a new bullet point and we have a previous fact to save
            evidence_items.append({
                "fact": current_fact,
                "source": current_source or "Not specified" 
            })
            current_fact = line
            current_source = ""
        else:
            # This is continuation of the current fact
            if current_fact:
                current_fact += " " + line
            else:
                current_fact = line
    
    # Add the last item if there is one
    if current_fact:
        evidence_items.append({
            "fact": current_fact,
            "source": current_source or "Not specified"
        })
    
    return evidence_items
