import React, { useState } from 'react';
import { AlertCircle, User, Users, ArrowRight, ChevronDown, ChevronUp, BarChart2 } from 'lucide-react';
import { ClaimAnalysis, Claim } from '../../types';

interface ClaimCardProps {
  claim: ClaimAnalysis;
  index?: number;
  perplexityResult?: Claim;
  openAIResult?: Claim;
  anthropicResult?: Claim;
}

const ClaimCard: React.FC<ClaimCardProps> = ({ 
  claim, 
  index, 
  perplexityResult,
  openAIResult,
  anthropicResult
}) => {
  const [expanded, setExpanded] = useState(false);
  
  // Calculate overall verification status
  const calculateVerificationStatus = () => {
    const results = [perplexityResult, openAIResult, anthropicResult].filter(Boolean) as Claim[];
    
    if (results.length === 0) {
      return { classification: 'UNVERIFIED', confidence: 0 };
    }
    
    // Count occurrences of each classification
    const classifications = results.map(r => r.classification);
    const counts = {
      TRUE: classifications.filter(c => c === 'TRUE').length,
      FALSE: classifications.filter(c => c === 'FALSE').length,
      UNVERIFIED: classifications.filter(c => c === 'UNVERIFIED').length
    };
    
    // Find the majority classification
    let majorityClassification = 'UNVERIFIED';
    let maxCount = 0;
    
    for (const [classification, count] of Object.entries(counts)) {
      if (count > maxCount) {
        maxCount = count;
        majorityClassification = classification;
      }
    }
    
    // Calculate average confidence
    const avgConfidence = results
      .map(r => r.confidence)
      .reduce((acc, val) => acc + val, 0) / results.length;
    
    return { 
      classification: majorityClassification as 'TRUE' | 'FALSE' | 'UNVERIFIED',
      confidence: Math.round(avgConfidence)
    };
  };
  
  const { classification, confidence } = calculateVerificationStatus();
  
  // Render the verification badge
  const renderVerificationBadge = () => {
    return (
      <div className={`px-3 py-1.5 font-medium text-sm flex items-center space-x-1.5 rounded-full ${
        classification === 'TRUE' 
          ? 'bg-green-100 text-green-700 border border-green-200' 
          : classification === 'FALSE'
            ? 'bg-red-100 text-red-700 border border-red-200'
            : 'bg-amber-100 text-amber-700 border border-amber-200'
      }`}>
        {classification === 'TRUE' && (
          <svg className="w-4 h-4 mr-1" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M7.75 12.75L10 15.25L16.25 8.75" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2"/>
          </svg>
        )}
        {classification === 'FALSE' && (
          <svg className="w-4 h-4 mr-1" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M15 9L9 15M9 9L15 15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2"/>
          </svg>
        )}
        {classification === 'UNVERIFIED' && (
          <svg className="w-4 h-4 mr-1" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M12 16V12M12 8H12.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2"/>
          </svg>
        )}
        <span>
          {classification === 'TRUE' ? 'True' : 
           classification === 'FALSE' ? 'False' : 
           'Unverified'}
        </span>
      </div>
    );
  };

  return (
    <div className="bg-white border border-gray-200 rounded-lg shadow-sm p-6">
      <div className="flex items-start justify-between mb-4">
        <div className="flex items-start">
          {index !== undefined && (
            <div className="flex-shrink-0 h-8 w-8 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center font-medium mr-3 mt-0.5">
              {index + 1}
            </div>
          )}
          <div>
            <div className="flex items-center space-x-2 mb-2">
              <AlertCircle className="h-5 w-5 text-blue-600" />
              <h2 className="text-lg font-semibold text-gray-900">Empirical Claim</h2>
              
              {claim.speaker && (
                <div className="flex items-center space-x-1 ml-3 px-2 py-0.5 bg-gray-100 rounded-full text-xs text-gray-700">
                  <User className="h-3 w-3" />
                  <span>{claim.speaker.name || `Speaker ${claim.speaker.id}`}</span>
                </div>
              )}
            </div>
            
            <p className="text-gray-800 font-medium bg-blue-50 p-3 rounded-lg border border-blue-100">
              {claim.claim}
            </p>
          </div>
        </div>
        
        <div className="flex flex-col items-end ml-4 space-y-2">
          {renderVerificationBadge()}
          
          <div className="flex items-center bg-gray-100 px-3 py-1 rounded-lg text-sm border border-gray-200">
            <BarChart2 className="h-3.5 w-3.5 text-gray-500 mr-1.5" />
            <span className="text-gray-800 font-medium">{confidence}%</span>
            <span className="text-gray-500 ml-1">confidence</span>
          </div>
        </div>
      </div>
      
      <div className="mt-4 space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="bg-gray-50 p-3 rounded-lg border border-gray-100">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center space-x-2">
                <div className="h-3 w-3 bg-blue-500 rounded-full"></div>
                <h3 className="text-sm font-medium text-gray-700">Perplexity</h3>
              </div>
              {perplexityResult && (
                <div className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                  perplexityResult.classification === 'TRUE' 
                    ? 'bg-green-100 text-green-700' 
                    : perplexityResult.classification === 'FALSE'
                      ? 'bg-red-100 text-red-700'
                      : 'bg-amber-100 text-amber-700'
                }`}>
                  {perplexityResult.classification}
                </div>
              )}
            </div>
            
            <div className="text-xs text-gray-700">
              {perplexityResult ? (
                <>
                  <div className="flex items-center mb-1.5">
                    <span className="mr-2 text-gray-500">Confidence:</span>
                    <div className="flex-1 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                      <div 
                        className="h-full bg-blue-500 rounded-full"
                        style={{ width: `${perplexityResult.confidence}%` }}
                      ></div>
                    </div>
                    <span className="ml-2 font-medium">{perplexityResult.confidence}%</span>
                  </div>
                  <p className="line-clamp-2">
                    {perplexityResult.supportingFacts?.substring(0, 100)}...
                  </p>
                </>
              ) : (
                <p className="text-gray-500 italic">No result available</p>
              )}
            </div>
          </div>
          
          <div className="bg-gray-50 p-3 rounded-lg border border-gray-100">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center space-x-2">
                <div className="h-3 w-3 bg-green-500 rounded-full"></div>
                <h3 className="text-sm font-medium text-gray-700">OpenAI</h3>
              </div>
              {openAIResult && (
                <div className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                  openAIResult.classification === 'TRUE' 
                    ? 'bg-green-100 text-green-700' 
                    : openAIResult.classification === 'FALSE'
                      ? 'bg-red-100 text-red-700'
                      : 'bg-amber-100 text-amber-700'
                }`}>
                  {openAIResult.classification}
                </div>
              )}
            </div>
            
            <div className="text-xs text-gray-700">
              {openAIResult ? (
                <>
                  <div className="flex items-center mb-1.5">
                    <span className="mr-2 text-gray-500">Confidence:</span>
                    <div className="flex-1 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                      <div 
                        className="h-full bg-green-500 rounded-full"
                        style={{ width: `${openAIResult.confidence}%` }}
                      ></div>
                    </div>
                    <span className="ml-2 font-medium">{openAIResult.confidence}%</span>
                  </div>
                  <p className="line-clamp-2">
                    {openAIResult.supportingFacts?.substring(0, 100)}...
                  </p>
                </>
              ) : (
                <p className="text-gray-500 italic">No result available</p>
              )}
            </div>
          </div>
          
          <div className="bg-gray-50 p-3 rounded-lg border border-gray-100">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center space-x-2">
                <div className="h-3 w-3 bg-purple-500 rounded-full"></div>
                <h3 className="text-sm font-medium text-gray-700">Anthropic</h3>
              </div>
              {anthropicResult && (
                <div className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                  anthropicResult.classification === 'TRUE' 
                    ? 'bg-green-100 text-green-700' 
                    : anthropicResult.classification === 'FALSE'
                      ? 'bg-red-100 text-red-700'
                      : 'bg-amber-100 text-amber-700'
                }`}>
                  {anthropicResult.classification}
                </div>
              )}
            </div>
            
            <div className="text-xs text-gray-700">
              {anthropicResult ? (
                <>
                  <div className="flex items-center mb-1.5">
                    <span className="mr-2 text-gray-500">Confidence:</span>
                    <div className="flex-1 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                      <div 
                        className="h-full bg-purple-500 rounded-full"
                        style={{ width: `${anthropicResult.confidence}%` }}
                      ></div>
                    </div>
                    <span className="ml-2 font-medium">{anthropicResult.confidence}%</span>
                  </div>
                  <p className="line-clamp-2">
                    {anthropicResult.supportingFacts?.substring(0, 100)}...
                  </p>
                </>
              ) : (
                <p className="text-gray-500 italic">No result available</p>
              )}
            </div>
          </div>
        </div>
      </div>
      
      <div className="mt-6 flex items-center justify-between">
        <div>
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-blue-600 hover:text-blue-800 text-sm font-medium flex items-center"
          >
            {expanded ? (
              <>
                <ChevronUp className="h-4 w-4 mr-1" />
                Show Less
              </>
            ) : (
              <>
                <ChevronDown className="h-4 w-4 mr-1" />
                Show Details
              </>
            )}
          </button>
        </div>
      </div>
      
      {expanded && (
        <div className="mt-6 space-y-4">
          <div>
            <h3 className="font-semibold text-gray-800 mb-2">Context:</h3>
            <p className="text-gray-700 whitespace-pre-line p-3 bg-gray-50 border border-gray-200 rounded-lg text-sm">{claim.context}</p>
          </div>
          
          <div>
            <h3 className="font-semibold text-gray-800 mb-2">Validation Approach:</h3>
            <p className="text-gray-700 p-3 bg-gray-50 border border-gray-200 rounded-lg text-sm">{claim.validationPotential}</p>
          </div>
          
          {claim.speaker && (
            <div>
              <h3 className="font-semibold text-gray-800 mb-2">Speaker Information:</h3>
              <div className="p-3 bg-gray-50 border border-gray-200 rounded-lg">
                <div className="flex items-center text-sm">
                  <Users className="h-5 w-5 text-gray-600 mr-2" />
                  <div>
                    <p className="font-medium text-gray-800">{claim.speaker.name || `Speaker ${claim.speaker.id}`}</p>
                    <p className="text-gray-600 text-xs">ID: {claim.speaker.id}</p>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default ClaimCard;