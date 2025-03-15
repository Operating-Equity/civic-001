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
        for line in lines:
            if re.search(fr'^(?:\d*\.?\s*)?{prefix}\s*:?\s*', line, re.IGNORECASE):
                # Remove the prefix and clean up
                content = re.sub(fr'^(?:\d*\.?\s*)?{prefix}\s*:?\s*', '', line, flags=re.IGNORECASE)
                return clean_text(content)
        return ''
    
    # Default: if structured parsing fails, take first line as claim
    claim = find_line('claim') or find_line('statement')
    if not claim and lines:
        claim = clean_text(lines[0])
        
    context = find_line('context') or find_line('background') or ''
    validation = find_line('validation') or find_line('verify') or ''
    
    return {
        "claim": claim,
        "context": context or "No context provided",
        "validationPotential": validation or "No validation approach specified"
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
