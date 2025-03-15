import requests
import json
import re
from flask import current_app

def call_openai_api(model, messages, temperature=0.3, max_tokens=None):
    """
    Generic function to call OpenAI API
    """
    api_key = current_app.config.get('OPENAI_API_KEY')
    if not api_key:
        raise Exception("OpenAI API key not configured")
        
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
    
    response = requests.post(
        "https://api.openai.com/v1/chat/completions",
        headers=headers,
        json=payload
    )
    
    if response.status_code != 200:
        raise Exception(f"OpenAI API error: {response.status_code} - {response.text}")
        
    return response.json()

def evaluate_with_openai(statement, context=""):
    """
    Evaluate a claim for factual accuracy using OpenAI
    Returns a structured analysis including classification, confidence score, and supporting facts
    """
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
        response = call_openai_api("gpt-4o", [
            {"role": "system", "content": system_message},
            {"role": "user", "content": user_message}
        ], temperature=0.2, max_tokens=2000)
        
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
