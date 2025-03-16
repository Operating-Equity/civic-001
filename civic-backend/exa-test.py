import os
import sys
import logging

# Configure logging
logging.basicConfig(level=logging.INFO, 
                   format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)


# Check if Exa API key is available
exa_api_key = "309a15b7-4f8c-4f2a-bc1b-4c81122e3351"
if not exa_api_key:
    logger.error("EXA_API_KEY is missing from environment variables")
    print("ERROR: EXA_API_KEY environment variable is not set")
    sys.exit(1)

print(f"Found EXA_API_KEY: {exa_api_key[:5]}...{exa_api_key[-4:] if len(exa_api_key) > 8 else ''}")

try:
    # Try importing the Exa library
    from exa_py import Exa
    print("Successfully imported Exa library")
    
    # Initialize Exa client
    exa = Exa(exa_api_key)
    print("Successfully initialized Exa client")
    
    # Test a simple search
    print("Testing search functionality...")
    query = "latest developments in AI 2024"
    
    response = exa.search_and_contents(
        query=query,
        text=True,
        highlights={
            "numSentences": 3,
            "highlightsPerUrl": 2,
            "query": f"Evidence about {query}"
        },
        summary={
            "query": "Provide key facts for fact-checking"
        },
    )
    
    # Print results
    print(f"Search successful! Found {len(response.results)} results")
    
    for i, result in enumerate(response.results):
        print(f"\nResult {i+1}:")
        print(f"Title: {result.title}")
        print(f"URL: {result.url}")
        print(f"Published Date: {result.published_date}")
        if hasattr(result, 'summary') and result.summary:
            print(f"Summary: {result.summary[:150]}...")
            
    print("\nExa API is working correctly!")
    
except ImportError:
    logger.error("Failed to import Exa library")
    print("ERROR: exa_py library is not installed. Run: pip install exa-py")
    sys.exit(1)
except Exception as e:
    logger.error(f"Error testing Exa API: {str(e)}")
    print(f"ERROR: Failed to use Exa API: {str(e)}")
    sys.exit(1)