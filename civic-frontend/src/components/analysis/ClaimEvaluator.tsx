import React, { useState, useEffect } from 'react';
import { ClaimAnalysis, Claim } from '../../types';
import AnalysisResults from './AnalysisResults';
import ServiceLoadingStatus from './ServiceLoadingStatus';
import { AlertTriangle } from 'lucide-react';

interface ClaimEvaluatorProps {
  empiricalClaims: ClaimAnalysis[];
}

const ClaimEvaluator: React.FC<ClaimEvaluatorProps> = ({ empiricalClaims }) => {
  const [isEvaluating, setIsEvaluating] = useState(false);
  const [evaluationStarted, setEvaluationStarted] = useState(false);
  const [currentClaimIndex, setCurrentClaimIndex] = useState(0);
  
  // Results for each service
  const [perplexityResults, setPerplexityResults] = useState<Claim[]>([]);
  const [openAIResults, setOpenAIResults] = useState<Claim[]>([]);
  const [anthropicResults, setAnthropicResults] = useState<Claim[]>([]);
  
  // Service statuses
  type ServiceStatus = 'idle' | 'loading' | 'success' | 'error';
  const [serviceStatus, setServiceStatus] = useState({
    perplexity: 'idle' as ServiceStatus,
    openai: 'idle' as ServiceStatus,
    anthropic: 'idle' as ServiceStatus
  });
  
  // Error messages
  const [errorMessages, setErrorMessages] = useState({
    perplexity: '',
    openai: '',
    anthropic: ''
  });
  
  useEffect(() => {
    console.log("[DEBUG ClaimEvaluator] Current status:", {
      evaluationStarted,
      isEvaluating,
      currentClaimIndex,
      serviceStatus,
      resultCounts: {
        perplexity: perplexityResults.length,
        openai: openAIResults.length,
        anthropic: anthropicResults.length
      }
    });
  }, [evaluationStarted, isEvaluating, currentClaimIndex, serviceStatus, perplexityResults, openAIResults, anthropicResults]);
  
  // Function to evaluate a single claim
  const evaluateClaim = async (claim: ClaimAnalysis) => {
    if (!claim) return;
    
    setIsEvaluating(true);
    setServiceStatus({
      perplexity: 'loading',
      openai: 'loading',
      anthropic: 'loading'
    });
    
    try {
      console.log("[DEBUG] Starting evaluation for claim:", claim.claim.substring(0, 50));
      
      const response = await fetch('/api/analysis/evaluate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          claim: claim.claim,
          context: claim.context,
          model: 'all'
        })
      });
      
      const data = await response.json();
      console.log("[DEBUG] API response:", data);
      console.log("[DEBUG] Models in response:", Object.keys(data));
      
      // Create fallback results for missing models
      const modelResults = {
        perplexity: data.perplexity || createFallbackResult(claim.claim, 'perplexity'),
        openai: data.openai || createFallbackResult(claim.claim, 'openai'),
        anthropic: data.anthropic || createFallbackResult(claim.claim, 'anthropic')
      };
      
      // Process results for all models, using fallbacks if needed
      processModelResult('perplexity', data, claim, modelResults.perplexity);
      processModelResult('openai', data, claim, modelResults.openai);
      processModelResult('anthropic', data, claim, modelResults.anthropic);
      
    } catch (error) {
      console.error('Error evaluating claim:', error);
      // Update all services to error state
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
      
      // Still add fallback results for all models
      const fallbackResult = createFallbackResult(claim.claim, 'error');
      setPerplexityResults(prev => [...prev, {...fallbackResult, model: 'Perplexity', claimId: claim.id}]);
      setOpenAIResults(prev => [...prev, {...fallbackResult, model: 'OpenAI', claimId: claim.id}]);
      setAnthropicResults(prev => [...prev, {...fallbackResult, model: 'Anthropic', claimId: claim.id}]);
    } finally {
      setIsEvaluating(false);
      
      // Move to the next claim
      setCurrentClaimIndex(prev => prev + 1);
    }
  };
  
  // Helper function to process results for a specific model
  const processModelResult = (
    modelName: 'perplexity' | 'openai' | 'anthropic', 
    data: any, 
    claim: ClaimAnalysis,
    fallbackResult: Claim
  ) => {
    // First, determine if this model has results
    const hasResults = modelName in data && data[modelName];
    
    // Set the appropriate state for this model
    if (modelName === 'perplexity') {
      // Add the result (or fallback) to the results array
      setPerplexityResults(prev => [...prev, {
        ...(hasResults ? data[modelName] : fallbackResult),
        claimId: claim.id
      }]);
      
      // Update service status and error message if needed
      setServiceStatus(prev => ({
        ...prev,
        perplexity: hasResults ? 'success' : 'error'
      }));
      
      if (!hasResults) {
        setErrorMessages(prev => ({
          ...prev,
          perplexity: `Failed to get results from Perplexity`
        }));
      }
    } 
    else if (modelName === 'openai') {
      setOpenAIResults(prev => [...prev, {
        ...(hasResults ? data[modelName] : fallbackResult),
        claimId: claim.id
      }]);
      
      setServiceStatus(prev => ({
        ...prev,
        openai: hasResults ? 'success' : 'error'
      }));
      
      if (!hasResults) {
        setErrorMessages(prev => ({
          ...prev,
          openai: `Failed to get results from OpenAI`
        }));
      }
    }
    else if (modelName === 'anthropic') {
      setAnthropicResults(prev => [...prev, {
        ...(hasResults ? data[modelName] : fallbackResult),
        claimId: claim.id
      }]);
      
      setServiceStatus(prev => ({
        ...prev,
        anthropic: hasResults ? 'success' : 'error'
      }));
      
      if (!hasResults) {
        setErrorMessages(prev => ({
          ...prev,
          anthropic: `Failed to get results from Anthropic`
        }));
      }
    }
  };
  
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
  
  // Start evaluation when claims are provided
  useEffect(() => {
    if (empiricalClaims.length > 0 && !evaluationStarted) {
      setEvaluationStarted(true);
      console.log("[DEBUG] Starting evaluation process with", empiricalClaims.length, "claims");
    }
  }, [empiricalClaims, evaluationStarted]);
  
  // Process claims one by one
  useEffect(() => {
    const processClaims = async () => {
      if (evaluationStarted && !isEvaluating && currentClaimIndex < empiricalClaims.length) {
        console.log("[DEBUG] Processing claim", currentClaimIndex + 1, "of", empiricalClaims.length);
        await evaluateClaim(empiricalClaims[currentClaimIndex]);
      }
    };
    
    processClaims();
  }, [evaluationStarted, isEvaluating, currentClaimIndex, empiricalClaims]);
  
  // Check if all claims have been evaluated
  const allClaimsEvaluated = currentClaimIndex >= empiricalClaims.length;
  
  // Loading state shows until all claims are evaluated
  const loading = evaluationStarted && !allClaimsEvaluated;
  
  // Display error if no claims to evaluate
  if (empiricalClaims.length === 0) {
    return (
      <div className="glass-panel p-6 text-center">
        <AlertTriangle className="h-12 w-12 text-yellow-500 mx-auto mb-4" />
        <h3 className="text-white text-lg font-medium mb-2">No Claims to Evaluate</h3>
        <p className="text-white/70">No empirical claims were found for evaluation.</p>
      </div>
    );
  }

  return (
    <div>
      {/* Show loading status when processing claims */}
      {loading && (
        <div className="glass-panel p-6 mb-6">
          <h2 className="text-xl font-semibold mb-6 text-white flex items-center">
            <AlertTriangle className="mr-2 h-5 w-5 text-primary" />
            Analyzing Claims
          </h2>
          
          <ServiceLoadingStatus 
            perplexityStatus={serviceStatus.perplexity}
            openAIStatus={serviceStatus.openai}
            anthropicStatus={serviceStatus.anthropic}
            errorMessages={errorMessages}
          />
          
          <p className="text-white/70 text-sm mt-6 text-center">
            Processing claim {currentClaimIndex + 1} of {empiricalClaims.length}. This may take a minute.
          </p>
        </div>
      )}
      
      <AnalysisResults
        empiricalClaims={empiricalClaims}
        perplexityResults={perplexityResults}
        openAIResults={openAIResults}
        anthropicResults={anthropicResults}
        isLoading={loading}
        serviceStatus={serviceStatus}
        errorMessages={errorMessages}
      />
      
      {evaluationStarted && allClaimsEvaluated && (
        <div className="mt-4 p-4 bg-green-500/20 border border-green-500/30 rounded-md">
          <p className="text-white text-center">
            All claims have been evaluated! Check the tabs above to see results from each service.
          </p>
        </div>
      )}
    </div>
  );
};

export default ClaimEvaluator;