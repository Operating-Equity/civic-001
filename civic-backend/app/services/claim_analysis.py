from flask import current_app
import requests
import json
import re
import uuid
from app.services.openai_service import call_openai_api
import concurrent.futures

def identify_claims(transcript, video_title="", speakers_data=None):
    """
    Extract empirical claims from a transcript using OpenAI.
    Also associates claims with speakers when speaker data is available.
    
    Args:
        transcript (str): The transcript text
        video_title (str): Title of the video
        speakers_data (dict): Optional speaker identification data
        
    Returns:
        list: A list of claim objects with claim text, context, validation potential,
              and speaker information when available.
    """
    system_message = """You are an expert at identifying empirical claims and preserving their testable nature. Your primary role is to:
1. Preserve the original empirical claim's testable nature
2. Only fix obvious spelling/punctuation errors in names and technical terms
3. DO NOT change the fundamental meaning or transform factual claims into opinions
4. Add relevant context that helps verify the claim
5. Suggest specific, measurable validation approaches
6. When speaker information is available, accurately attribute claims to their speakers

Empirical claims must remain testable and falsifiable. Separate claims with '---'. Be direct and avoid markdown formatting."""

    user_message = f"""Extract empirical claims from this transcript, preserving their testable nature and only fixing clear transcription errors. For each claim, provide:
1. The empirical claim (maintaining its testable nature)
2. Relevant context
3. Specific validation approach

Video Title: {video_title}

Transcript:
{transcript}"""

    # Add speaker instructions if speaker data is available
    if speakers_data and isinstance(speakers_data, dict) and speakers_data.get('segments'):
        user_message += "\n\nSpeaker Information is available. For each claim, identify which speaker made the claim using the following speaker data:\n"
        user_message += json.dumps(speakers_data, indent=2)

    try:
        response = call_openai_api("gpt-4o", [
            {"role": "system", "content": system_message},
            {"role": "user", "content": user_message}
        ])
        
        response_text = response['choices'][0]['message']['content']
        
        # Split claims and parse them
        raw_claims = response_text.split('---')
        claims = []
        
        def process_claim(raw_claim):
            # Process a single claim
            claim_text = raw_claim.strip()
            if not claim_text:
                return None
                
            # Extract claim, context, and validation information
            parsed_claim = parse_claim_content(claim_text, speakers_data)
            
            # Generate a unique ID for each claim
            if parsed_claim['claim']:  # Only add if we successfully extracted a claim
                parsed_claim['id'] = str(uuid.uuid4())
                return parsed_claim
            return None
        
        # Process claims in parallel if there are many
        if len(raw_claims) > 5:
            with concurrent.futures.ThreadPoolExecutor() as executor:
                future_claims = [executor.submit(process_claim, rc) for rc in raw_claims if rc.strip()]
                for future in concurrent.futures.as_completed(future_claims):
                    result = future.result()
                    if result:
                        claims.append(result)
        else:
            # Process sequentially for fewer claims
            for raw_claim in raw_claims:
                result = process_claim(raw_claim)
                if result:
                    claims.append(result)
        
        # If no claims were found, add a placeholder
        if not claims:
            claims.append({
                "id": str(uuid.uuid4()),
                "claim": "No valid claims found in transcript",
                "context": "The transcript analysis did not yield any verifiable claims",
                "validationPotential": "Please review the transcript and try again",
                "speaker": None
            })
            
        return claims
        
    except Exception as e:
        raise Exception(f"Failed to identify empirical claims: {str(e)}")

def parse_claim_content(text, speakers_data=None):
    """
    Parse raw claim text into structured format including speaker attribution if available
    
    Args:
        text (str): Raw claim text
        speakers_data (dict): Optional speaker identification data
        
    Returns:
        dict: Structured claim data with speaker attribution if available
    """
    lines = text.strip().split('\n')
    
    # Helper to find specific content
    def find_line(prefix):
        for i, line in enumerate(lines):
            if re.search(fr'^(?:\d*\.?\s*)?{prefix}\s*:?\s*', line, re.IGNORECASE):
                # Remove the prefix and clean up
                content = re.sub(fr'^(?:\d*\.?\s*)?{prefix}\s*:?\s*', '', line, flags=re.IGNORECASE)
                
                # Check if the next line might be a continuation
                if i + 1 < len(lines) and not re.search(r'^(?:\d*\.?\s*)?(claim|context|validation|background|verify|statement|speaker)\s*:?\s*', lines[i+1], re.IGNORECASE):
                    # Combine with next line(s) until we hit another key or run out of lines
                    j = i + 1
                    while j < len(lines) and not re.search(r'^(?:\d*\.?\s*)?(claim|context|validation|background|verify|statement|speaker)\s*:?\s*', lines[j], re.IGNORECASE):
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
    
    # Extract speaker information if available
    speaker = find_line('speaker')
    
    # If no explicit speaker information but speakers_data is provided, try to match
    if not speaker and speakers_data and speakers_data.get('segments'):
        # This is a simplified approach - in production, you would use more sophisticated text matching
        speaker = find_speaker_for_claim(claim, speakers_data)
    
    # Generate context if missing
    if not context:
        # Extract any information that might provide context
        for line in lines:
            # If line isn't the claim or validation but has content
            if (line and clean_text(line) != claim and 
                not re.search(r'^(?:\d*\.?\s*)?(validation|verify|speaker)', line, re.IGNORECASE)):
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
        "validationPotential": validation or "Describe methods to verify this claim using data, documentation, or expert testimony",
        "speaker": speaker or None
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

def find_speaker_for_claim(claim, speakers_data):
    """
    Attempt to match a claim with a speaker using the speaker segments data
    
    Args:
        claim (str): The claim text
        speakers_data (dict): Speaker identification data with segments
        
    Returns:
        str: Speaker identifier or None if no match found
    """
    if not speakers_data or not speakers_data.get('segments'):
        return None
    
    # This is a simplified approach - a real implementation would use more sophisticated 
    # text matching, possibly with embedding-based similarity
    
    # Normalize claim text for better matching
    normalized_claim = clean_text(claim.lower())
    
    for segment in speakers_data['segments']:
        # Check if the segment text contains the claim or vice versa
        segment_text = segment.get('text', '').lower()
        if normalized_claim in segment_text or segment_text in normalized_claim:
            # Return the speaker information
            return {
                "id": segment.get('speaker', 'unknown'),
                "name": speakers_data.get('speakers', {}).get(segment.get('speaker', 'unknown'), 'Unknown Speaker')
            }
    
    return None

def generate_summary(transcript, video_title=""):
    """Generate a concise summary of a transcript using OpenAI"""
    system_message = "You are an expert at summarizing video transcripts. Provide a concise, informative summary."
    user_message = f"Please summarize this transcript about '{video_title}':\n\n{transcript}" if video_title else f"Please summarize this transcript:\n\n{transcript}"
    
    try:
        response = call_openai_api("gpt-4o", [
            {"role": "system", "content": system_message},
            {"role": "user", "content": user_message}
        ])
        
        return response['choices'][0]['message']['content']
    except Exception as e:
        raise Exception(f"Failed to generate summary: {str(e)}")

def batch_evaluate_claims(claims, context="", model="all"):
    """
    Process multiple claims in parallel
    
    Args:
        claims (list): List of claim objects with claim text and other metadata
        context (str): Global context to use for all claims
        model (str): Which model(s) to use for evaluation
        
    Returns:
        dict: Dictionary of evaluation results keyed by claim ID
    """
    from app.api.analysis_routes import evaluate_multiple_claims
    from flask import request
    
    # Format the claims for the API
    formatted_claims = []
    for claim in claims:
        formatted_claims.append({
            "id": claim.get("id", str(uuid.uuid4())),
            "claim": claim["claim"],
            "context": claim.get("context", "")
        })
    
    # Mock a request object
    class MockRequest:
        def __init__(self, json_data):
            self.json = json_data
    
    # Create a mock request with claims data
    mock_request = MockRequest({
        "claims": formatted_claims,
        "context": context,
        "model": model
    })
    
    # Use the existing evaluate_multiple_claims function
    # In a production implementation, this would be restructured to avoid this approach
    old_request = request
    request = mock_request
    try:
        result = evaluate_multiple_claims()
        return result.json
    finally:
        request = old_request