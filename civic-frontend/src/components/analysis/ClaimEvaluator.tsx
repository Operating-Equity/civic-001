import React, { useState, useEffect } from 'react';
import { Shield, ArrowRight, RefreshCw, Download, Award } from 'lucide-react';
import { ClaimAnalysis, Claim, SpeakersData } from '../../types';
import AnalysisResults from './AnalysisResults';
import ServiceLoadingStatus from './ServiceLoadingStatus';
import VerificationCertificate from './VerificationCertificate';

interface ClaimEvaluatorProps {
  empiricalClaims: ClaimAnalysis[];
  perplexityResults?: Claim[];
  openAIResults?: Claim[];
  anthropicResults?: Claim[];
  speakersData?: SpeakersData | null;
  videoTitle?: string;
  thumbnailUrl?: string;
  processingClaimIndex?: number;
}

// Define a type for possible service statuses
type ServiceStatusType = 'idle' | 'loading' | 'success' | 'error';

const ClaimEvaluator: React.FC<ClaimEvaluatorProps> = ({ 
  empiricalClaims,
  perplexityResults = [],
  openAIResults = [],
  anthropicResults = [],
  speakersData,
  videoTitle,
  thumbnailUrl,
  processingClaimIndex = -1
}) => {
  const [isEvaluating, setIsEvaluating] = useState(false);
  const [evaluationStarted, setEvaluationStarted] = useState(false);
  const [currentClaimIndex, setCurrentClaimIndex] = useState(0);
  const [showCertificate, setShowCertificate] = useState(false);
  
  // Service statuses
  const [serviceStatus, setServiceStatus] = useState<{
    perplexity: ServiceStatusType;
    openai: ServiceStatusType;
    anthropic: ServiceStatusType;
  }>({
    perplexity: 'idle',
    openai: 'idle',
    anthropic: 'idle'
  });
  
  // Error messages
  const [errorMessages, setErrorMessages] = useState({
    perplexity: '',
    openai: '',
    anthropic: ''
  });
  
  // Track if all processing is complete
  const [processingComplete, setProcessingComplete] = useState(false);
  
  // Check if we have results for claims
  const hasPerplexityResults = perplexityResults.length > 0;
  const hasOpenAIResults = openAIResults.length > 0;
  const hasAnthropicResults = anthropicResults.length > 0;
  
  // Check if all models have results
  const hasAllResults = 
    hasPerplexityResults && 
    hasOpenAIResults && 
    hasAnthropicResults &&
    perplexityResults.length === empiricalClaims.length &&
    openAIResults.length === empiricalClaims.length &&
    anthropicResults.length === empiricalClaims.length;
  
  // Handle certificate generation
  const handleViewCertificate = () => {
    setShowCertificate(true);
  };
  
  const handleCloseCertificate = () => {
    setShowCertificate(false);
  };
  
  // Set processing status based on prop values
  useEffect(() => {
    // If we have a valid processing claim index, we're in evaluation mode
    const stillProcessing = processingClaimIndex >= 0;
    setIsEvaluating(stillProcessing);
    
    if (stillProcessing) {
      setCurrentClaimIndex(processingClaimIndex);
      setEvaluationStarted(true);
      setServiceStatus({
        perplexity: 'loading',
        openai: 'loading',
        anthropic: 'loading'
      });
    } else if (hasAllResults) {
      // If we have all results, mark as complete
      setProcessingComplete(true);
      setServiceStatus({
        perplexity: 'success',
        openai: 'success',
        anthropic: 'success'
      });
    }
  }, [processingClaimIndex, hasAllResults, empiricalClaims.length]);
  
  // Display error if no claims to evaluate
  if (empiricalClaims.length === 0) {
    return (
      <div className="glass-panel p-6 text-center">
        <div className="bg-amber-50 p-6 rounded-lg border border-amber-200">
          <Shield className="h-12 w-12 text-amber-500 mx-auto mb-4" />
          <h3 className="text-gray-900 text-lg font-medium mb-2">No Claims to Evaluate</h3>
          <p className="text-gray-600">No empirical claims were found for evaluation in this video.</p>
        </div>
      </div>
    );
  }

  return (
    <div>
      {/* Show processing status when in progress */}
      {isEvaluating && (
        <div className="glass-panel p-6 mb-6">
          <h2 className="text-xl font-semibold mb-6 text-gray-900 flex items-center">
            <Shield className="mr-2 h-5 w-5 text-blue-600" />
            Analyzing Claims
          </h2>
          
          <ServiceLoadingStatus 
            perplexityStatus={serviceStatus.perplexity}
            openAIStatus={serviceStatus.openai}
            anthropicStatus={serviceStatus.anthropic}
            errorMessages={errorMessages}
            currentClaimIndex={currentClaimIndex}
            totalClaims={empiricalClaims.length}
            showProgressNumber={false} // Don't show sequential numbers
          />
          
          <div className="bg-blue-50 border border-blue-100 rounded-lg p-4 mt-6">
            <p className="text-blue-700 text-sm font-medium">Parallel Processing</p>
            <p className="text-blue-600 text-xs mt-1">
              All {empiricalClaims.length} claims are being processed simultaneously by our AI models
            </p>
          </div>
        </div>
      )}
      
      {/* Show certificate when requested */}
      {showCertificate ? (
        <div className="mb-6">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-xl font-semibold text-gray-900 flex items-center">
              <Award className="mr-2 h-5 w-5 text-blue-600" />
              Verification Certificate
            </h2>
            <button
              onClick={handleCloseCertificate}
              className="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg text-sm flex items-center"
            >
              <ArrowRight className="h-4 w-4 mr-1.5 transform rotate-180" />
              <span>Back to Results</span>
            </button>
          </div>
          
          <VerificationCertificate
            videoTitle={videoTitle || 'Analyzed Video'}
            thumbnailUrl={thumbnailUrl}
            claims={empiricalClaims}
            perplexityResults={perplexityResults}
            openAIResults={openAIResults}
            anthropicResults={anthropicResults}
          />
        </div>
      ) : (
        <AnalysisResults
          empiricalClaims={empiricalClaims}
          perplexityResults={perplexityResults}
          openAIResults={openAIResults}
          anthropicResults={anthropicResults}
          speakersData={speakersData}
          videoTitle={videoTitle}
          thumbnailUrl={thumbnailUrl}
          isLoading={isEvaluating}
          serviceStatus={serviceStatus}
          errorMessages={errorMessages}
          processingClaimIndex={processingClaimIndex || currentClaimIndex}
        />
      )}
      
      {/* Action buttons after processing */}
      {processingComplete && !showCertificate && (
        <div className="mt-6 flex flex-wrap justify-center sm:justify-end gap-3">
          <button 
            className="px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-800 rounded-lg border border-gray-200 text-sm font-medium flex items-center transition-colors"
            onClick={() => window.open('mailto:?subject=Civic%20Verification%20Results&body=I%20wanted%20to%20share%20these%20verification%20results%20with%20you.%0A%0AVideo:%20' + encodeURIComponent(videoTitle || 'Video Verification') + '%0A%0AVerified%20by%20Civic:%20https://civic-tech.org/verify')}
          >
            <RefreshCw className="h-4 w-4 mr-1.5" />
            <span>Re-analyze Video</span>
          </button>
          
          <button 
            className="px-4 py-2 bg-blue-100 hover:bg-blue-200 text-blue-800 rounded-lg border border-blue-200 text-sm font-medium flex items-center transition-colors"
            onClick={() => window.open('mailto:?subject=Civic%20Verification%20Results&body=I%20wanted%20to%20share%20these%20verification%20results%20with%20you.%0A%0AVideo:%20' + encodeURIComponent(videoTitle || 'Video Verification') + '%0A%0AVerified%20by%20Civic:%20https://civic-tech.org/verify')}
          >
            <Download className="h-4 w-4 mr-1.5" />
            <span>Export Results</span>
          </button>
          
          <button 
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium flex items-center transition-colors"
            onClick={handleViewCertificate}
          >
            <Award className="h-4 w-4 mr-1.5" />
            <span>View Certificate</span>
          </button>
        </div>
      )}
    </div>
  );
};

export default ClaimEvaluator;