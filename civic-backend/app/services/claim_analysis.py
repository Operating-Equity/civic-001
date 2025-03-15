from flask import current_app
import requests
import json
import re
from app.services.openai_service import call_openai_api

def identify_claims(transcript):
    """
    Extract empirical claims from a transcript using OpenAI.
    Returns a list of claim objects with claim text, context, and validation potential.
    """
    system_message = """You are an expert at identifying empirical claims and preserving their testable nature. Your primary role is to:
1. Preserve the original empirical claim's testable nature
2. Only fix obvious spelling/punctuation errors in names and technical terms
3. DO NOT change the fundamental meaning or transform factual claims into opinions
4. Add relevant context that helps verify the claim
5. Suggest specific, measurable validation approaches

Empirical claims must remain testable and falsifiable. Separate claims with '---'. Be direct and avoid markdown formatting."""

    user_message = f"""Extract empirical claims from this transcript, preserving their testable nature and only fixing clear transcription errors. For each claim, provide:
1. The empirical claim (maintaining its testable nature)
2. Relevant context
3. Specific validation approach

Transcript:
{transcript}"""

    try:
        response = call_openai_api("gpt-4o", [
            {"role": "system", "content": system_message},
            {"role": "user", "content": user_message}
        ])
        
        response_text = response['choices'][0]['message']['content']
        
        # Split claims and parse them
        raw_claims = response_text.split('---')
        claims = []
        
        for raw_claim in raw_claims:
            claim_text = raw_claim.strip()
            if not claim_text:
                continue
                
            # Extract claim, context, and validation information
            parsed_claim = parse_claim_content(claim_text)
            
            if parsed_claim['claim']:  # Only add if we successfully extracted a claim
                claims.append(parsed_claim)
        
        # If no claims were found, add a placeholder
        if not claims:
            claims.append({
                "claim": "No valid claims found in transcript",
                "context": "The transcript analysis did not yield any verifiable claims",
                "validationPotential": "Please review the transcript and try again"
            })
            
        return claims
        
    except Exception as e:
        raise Exception(f"Failed to identify empirical claims: {str(e)}")

def parse_claim_content(text):
    """Parse raw claim text into structured format"""
    lines = text.strip().split('\n')
    
    # Helper to find specific content
    def find_line(prefix):
        for i, line in enumerate(lines):
            if re.search(fr'^(?:\d*\.?\s*)?{prefix}\s*:?\s*', line, re.IGNORECASE):
                # Remove the prefix and clean up
                content = re.sub(fr'^(?:\d*\.?\s*)?{prefix}\s*:?\s*', '', line, flags=re.IGNORECASE)
                
                # Check if the next line might be a continuation
                if i + 1 < len(lines) and not re.search(r'^(?:\d*\.?\s*)?(claim|context|validation|background|verify|statement)\s*:?\s*', lines[i+1], re.IGNORECASE):
                    # Combine with next line(s) until we hit another key or run out of lines
                    j = i + 1
                    while j < len(lines) and not re.search(r'^(?:\d*\.?\s*)?(claim|context|validation|background|verify|statement)\s*:?\s*', lines[j], re.IGNORECASE):
                        content += " " + lines[j].strip()
                        j += 1
                
                return clean_text(content)
        return ''
    
    # Try various patterns for claim
    claim = find_line('claim') or find_line('statement')
    if not claim and lines:
        claim = clean_text(lines[0])
    
    # Enhanced context search - looks for multiple variations
    context = find_line('context') or find_line('background') or find_line('relevant context')
    
    # Enhanced validation search - looks for multiple variations
    validation = (find_line('validation') or find_line('verify') or 
                 find_line('validation approach') or find_line('validation potential') or 
                 find_line('how to verify'))
    
    # Generate context if missing
    if not context:
        # Extract any information that might provide context
        for line in lines:
            # If line isn't the claim or validation but has content
            if (line and clean_text(line) != claim and 
                not re.search(r'^(?:\d*\.?\s*)?(validation|verify)', line, re.IGNORECASE)):
                context = clean_text(line)
                if context and context != claim:
                    break
    
    # Generate validation approach if missing
    if not validation:
        # Try to find anything about verification methods
        for line in lines:
            if re.search(r'(verify|check|test|measure|assess|evaluate|compare|review)', line, re.IGNORECASE):
                validation = clean_text(line)
                if validation and validation != claim and validation != context:
                    break
    
    return {
        "claim": claim,
        "context": context or "Reference specific events, locations, or timeframes that provide background for this claim",
        "validationPotential": validation or "Describe methods to verify this claim using data, documentation, or expert testimony"
    }

def clean_text(text):
    """Clean up markdown and formatting from text"""
    # Remove markdown formatting
    text = re.sub(r'\*\*(.*?)\*\*', r'\1', text)  # Bold
    text = re.sub(r'_(.*?)_', r'\1', text)        # Italic
    text = re.sub(r'`(.*?)`', r'\1', text)        # Code
    
    # Remove claim statement prefixes
    text = re.sub(r'^Claim Statement:\s*', '', text, flags=re.IGNORECASE)
    
    return text.strip()

def generate_summary(transcript):
    """Generate a concise summary of a transcript using OpenAI"""
    system_message = "You are an expert at summarizing video transcripts. Provide a concise, informative summary."
    user_message = f"Please summarize this transcript:\n\n{transcript}"
    
    try:
        response = call_openai_api("gpt-4o", [
            {"role": "system", "content": system_message},
            {"role": "user", "content": user_message}
        ])
        
        return response['choices'][0]['message']['content']
    except Exception as e:
        raise Exception(f"Failed to generate summary: {str(e)}")
