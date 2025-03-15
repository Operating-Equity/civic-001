import { useState, useCallback } from 'react';
import { 
  ClaimAnalysis, 
  Claim,
  VideoAnalysisResult,
  ServiceStatus
} from '../types';
import { 
  processVideoUrl, 
  processVideoFile,
  evaluateClaim 
} from '../services/api';

export const useVideoAnalysis = () => {
  const [transcript, setTranscript] = useState('');
  const [thumbnailUrl, setThumbnailUrl] = useState('');
  const [summary, setSummary] = useState('');
  const [videoTitle, setVideoTitle] = useState('');
  
  const [empiricalClaims, setEmpiricalClaims] = useState<ClaimAnalysis[]>([]);
  const [perplexityResults, setPerplexityResults] = useState<Claim[]>([]);
  const [openAIResults, setOpenAIResults] = useState<Claim[]>([]);
  const [anthropicResults, setAnthropicResults] = useState<Claim[]>([]);
  
  // Track loading state for each service
  const [serviceStatus, setServiceStatus] = useState({
    perplexity: 'idle' as ServiceStatus,
    openai: 'idle' as ServiceStatus,
    anthropic: 'idle' as ServiceStatus
  });
  
  // Track error messages for each service
  const [errorMessages, setErrorMessages] = useState({
    perplexity: '',
    openai: '',
    anthropic: ''
  });
  
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [processingClaimIndex, setProcessingClaimIndex] = useState(-1);
  
  const resetStates = useCallback(() => {
    setTranscript('');
    setThumbnailUrl('');
    setSummary('');
    setVideoTitle('');
    setEmpiricalClaims([]);
    setPerplexityResults([]);
    setOpenAIResults([]);
    setAnthropicResults([]);
    setError(null);
    setServiceStatus({
      perplexity: 'idle',
      openai: 'idle',
      anthropic: 'idle'
    });
    setErrorMessages({
      perplexity: '',
      openai: '',
      anthropic: ''
    });
    setProcessingClaimIndex(-1);
  }, []);
  
  const handleVideoSubmit = useCallback(async (input: { type: 'file' | 'url'; value: File | string; model?: string }) => {
    setIsLoading(true);
    setError(null);
    resetStates();
    
    try {
      let result: VideoAnalysisResult;
      
      if (input.type === 'url') {
        result = await processVideoUrl(input.value as string);
      } else {
        result = await processVideoFile(input.value as File);
      }
      
      // Set the basic video analysis results
      setTranscript(result.transcript);
      setSummary(result.summary);
      setEmpiricalClaims(result.empiricalClaims);
      setVideoTitle(result.videoTitle);
      
      if (result.thumbnailUrl) {
        setThumbnailUrl(result.thumbnailUrl);
      }
      
      // Process claims with AI models
      if (result.empiricalClaims.length > 0) {
        processClaims(result.empiricalClaims, result.summary);
      }
      
    } catch (error: any) {
      setError(error.message || 'Failed to process video');
      console.error('Error processing video:', error);
    } finally {
      setIsLoading(false);
    }
  }, [resetStates]);
  
  const processClaims = useCallback(async (claims: ClaimAnalysis[], summary: string) => {
    if (!claims.length) return;
    
    // Process claims one by one to avoid rate limits
    for (let i = 0; i < claims.length; i++) {
      setProcessingClaimIndex(i);
      const claim = claims[i];
      
      // Reset service status for new claim
      setServiceStatus({
        perplexity: 'loading',
        openai: 'loading',
        anthropic: 'loading'
      });
      
      try {
        // Create context including summary and specific claim context
        const context = `
Video Summary:
${summary}

Claim Context:
${claim.context}

Validation Approach:
${claim.validationPotential}
        `;
        
        // Evaluate claim with all models
        console.log(`[DEBUG] Evaluating claim ${i + 1}/${claims.length}: "${claim.claim.substring(0, 50)}..."`);
        const results = await evaluateClaim(claim.claim, context);
        console.log('[DEBUG] API response:', results);
        console.log('[DEBUG] Models in response:', Object.keys(results));
        
        // Force model results in case the API response is incomplete
        const modelResults = {
          perplexity: results.perplexity || createFallbackResult(claim.claim, 'perplexity'),
          openai: results.openai || createFallbackResult(claim.claim, 'openai'),
          anthropic: results.anthropic || createFallbackResult(claim.claim, 'anthropic')
        };
        
        console.log('[DEBUG] Processed model results:', Object.keys(modelResults));
        
        // Process Perplexity result
        setPerplexityResults(prev => [...prev, {
          ...modelResults.perplexity,
          claimId: claim.id
        }]);
        setServiceStatus(prev => ({
          ...prev,
          perplexity: results.perplexity ? 'success' : 'error'
        }));
        if (!results.perplexity) {
          setErrorMessages(prev => ({
            ...prev,
            perplexity: 'Failed to get results from Perplexity'
          }));
        }
        
        // Process OpenAI result
        setOpenAIResults(prev => [...prev, {
          ...modelResults.openai,
          claimId: claim.id
        }]);
        setServiceStatus(prev => ({
          ...prev,
          openai: results.openai ? 'success' : 'error'
        }));
        if (!results.openai) {
          setErrorMessages(prev => ({
            ...prev,
            openai: 'Failed to get results from OpenAI'
          }));
        }
        
        // Process Anthropic result
        setAnthropicResults(prev => [...prev, {
          ...modelResults.anthropic,
          claimId: claim.id
        }]);
        setServiceStatus(prev => ({
          ...prev,
          anthropic: results.anthropic ? 'success' : 'error'
        }));
        if (!results.anthropic) {
          setErrorMessages(prev => ({
            ...prev,
            anthropic: 'Failed to get results from Anthropic'
          }));
        }
        
        console.log('[DEBUG] Results processed for all services');
        
      } catch (error: any) {
        console.error(`Error processing claim ${i + 1}:`, error);
        // Create fallback results for all services
        const fallbackResult = createFallbackResult(claim.claim, 'error');
        
        // Add fallback results for all services
        setPerplexityResults(prev => [...prev, { ...fallbackResult, model: 'Perplexity', claimId: claim.id }]);
        setOpenAIResults(prev => [...prev, { ...fallbackResult, model: 'OpenAI', claimId: claim.id }]);
        setAnthropicResults(prev => [...prev, { ...fallbackResult, model: 'Anthropic', claimId: claim.id }]);
        
        // Update all services to error state if the request fails completely
        setServiceStatus({
          perplexity: 'error',
          openai: 'error',
          anthropic: 'error'
        });
        setErrorMessages({
          perplexity: 'Network error occurred',
          openai: 'Network error occurred',
          anthropic: 'Network error occurred'
        });
      }
    }
    
    // After processing all claims, log the final results count
    console.log('[DEBUG] Final result counts:', {
      perplexity: perplexityResults.length,
      openai: openAIResults.length,
      anthropic: anthropicResults.length
    });
    
    // Reset processing index when done
    setProcessingClaimIndex(-1);
  }, []);
  
  // Helper function to create a fallback result when a model fails
  const createFallbackResult = (claim: string, errorSource: string): Claim => {
    return {
      statement: claim,
      classification: 'UNVERIFIED',
      confidence: 0,
      supportingFacts: `Error: Could not evaluate claim with ${errorSource}`,
      error: `Failed to get evaluation from ${errorSource}`,
      model: errorSource.charAt(0).toUpperCase() + errorSource.slice(1)
    };
  };
  
  return {
    // State
    transcript,
    thumbnailUrl,
    summary,
    videoTitle,
    empiricalClaims,
    perplexityResults,
    openAIResults,
    anthropicResults,
    isLoading,
    error,
    serviceStatus,
    errorMessages,
    processingClaimIndex,
    
    // Actions
    handleVideoSubmit,
    resetStates
  };
};