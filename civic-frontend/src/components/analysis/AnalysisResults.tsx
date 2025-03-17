import React, { useState } from 'react';
import { 
  CheckCircle, XCircle, AlertCircle, BarChart4, FileText, Shield, 
  BarChart2, Users, Award, Info, ExternalLink, Download
} from 'lucide-react';
import { ClaimAnalysis, Claim } from '../../types';
import FactCheckCard from './FactCheckCard';
import ModelComparison from './ModelComparison';
import ServiceLoadingStatus, { ServiceStatus } from './ServiceLoadingStatus';
import ClaimCard from './ClaimCard';
import VerificationCertificate from './VerificationCertificate';

interface AnalysisResultsProps {
  empiricalClaims: ClaimAnalysis[];
  perplexityResults: Claim[];
  openAIResults: Claim[];
  speakersData?: any;
  videoTitle?: string;
  thumbnailUrl?: string;
  isLoading?: boolean;
  serviceStatus?: {
    perplexity: ServiceStatus;
    openai: ServiceStatus;
  };
  errorMessages?: {
    perplexity?: string;
    openai?: string;
  };
  processingClaimIndex?: number; // Add this prop
}

type TabType = 'dashboard' | 'claims' | 'perplexity' | 'openai' | 'comparison' | 'certificate';

const AnalysisResults: React.FC<AnalysisResultsProps> = ({
  empiricalClaims,
  perplexityResults,
  openAIResults,
  speakersData,
  videoTitle,
  thumbnailUrl,
  isLoading = false,
  serviceStatus = {
    perplexity: 'idle',
    openai: 'idle'
  },
  errorMessages = {},
  processingClaimIndex = -1 // Add default value
}) => {
  const [activeTab, setActiveTab] = useState<TabType>('dashboard');
  
  // Calculate aggregated metrics for dashboard
  const calculateAggregatedMetrics = () => {
    // Count claim classifications across all models
    const allResults = [...perplexityResults, ...openAIResults];
    
    const counts = {
      TRUE: 0,
      FALSE: 0,
      UNVERIFIED: 0
    };
    
    allResults.forEach(result => {
      if (result.classification in counts) {
        counts[result.classification]++;
      }
    });
    
    // Calculate average confidence
    const totalConfidence = allResults.reduce((sum, result) => sum + result.confidence, 0);
    const avgConfidence = allResults.length > 0 ? Math.round(totalConfidence / allResults.length) : 0;
    
    // Calculate agreement rate between models
    let agreementCount = 0;
    let totalComparisons = 0;
    
    // For each claim, check if the two models agree
    if (perplexityResults.length === openAIResults.length) {
      for (let i = 0; i < perplexityResults.length; i++) {
        if (perplexityResults[i].classification === openAIResults[i].classification) {
          agreementCount++;
        }
        totalComparisons++;
      }
    }
    
    const agreementRate = totalComparisons > 0 ? Math.round((agreementCount / totalComparisons) * 100) : 0;
    
    return {
      counts,
      avgConfidence,
      agreementRate,
      totalClaims: empiricalClaims.length,
      totalVerifications: allResults.length / 2 // Divide by 2 models
    };
  };
  
  const metrics = calculateAggregatedMetrics();
  
  if (isLoading) {
    return (
      <div className="glass-panel p-6 min-h-[300px]">
        <div className="mb-6">
          <div className="flex items-center space-x-2 mb-3">
            <div className="p-1.5 bg-blue-100 rounded-md">
              <Shield className="h-5 w-5 text-blue-600" />
            </div>
            <h2 className="text-xl font-semibold text-gray-900">Verification in Progress</h2>
          </div>
        </div>
        
        <ServiceLoadingStatus 
          perplexityStatus={serviceStatus.perplexity}
          openAIStatus={serviceStatus.openai}
          errorMessages={errorMessages}
          currentClaimIndex={processingClaimIndex}
          totalClaims={empiricalClaims.length}
        />
        
        <p className="text-gray-700 text-sm mt-6 text-center">
          Cross-referencing claims across multiple verification models for accuracy
        </p>
      </div>
    );
  }
  
  if (empiricalClaims.length === 0) {
    return null;
  }

  return (
    <div className="glass-panel p-6">
      <div className="mb-6">
        <div className="flex items-center space-x-2 mb-3">
          <div className="p-1.5 bg-blue-100 rounded-md">
            <Shield className="h-5 w-5 text-blue-600" />
          </div>
          <h2 className="text-xl font-semibold text-gray-900">Verification Control Station</h2>
        </div>
        
        <div className="py-2 px-4 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-700">
          <p>Analysis of {metrics.totalClaims} empirical claim{metrics.totalClaims !== 1 ? 's' : ''} verified across 2 AI models</p>
        </div>
      </div>
      
      {/* Tabs - Enhanced Design */}
      <div className="border-b border-gray-200 mb-6">
        <div className="flex flex-wrap -mb-px overflow-x-auto">
          <button
            onClick={() => setActiveTab('dashboard')}
            className={`mr-4 py-3 px-3 border-b-2 font-medium text-sm flex items-center space-x-1.5
              ${activeTab === 'dashboard' 
                ? 'border-blue-600 text-blue-600' 
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'}
            `}
          >
            <BarChart2 className="h-4 w-4" />
            <span>Dashboard</span>
          </button>
          
          <button
            onClick={() => setActiveTab('claims')}
            className={`mr-4 py-3 px-3 border-b-2 font-medium text-sm flex items-center space-x-1.5
              ${activeTab === 'claims' 
                ? 'border-blue-600 text-blue-600' 
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'}
            `}
          >
            <FileText className="h-4 w-4" />
            <span>Claims {empiricalClaims.length > 0 ? `(${empiricalClaims.length})` : ''}</span>
          </button>
          
          <button
            onClick={() => setActiveTab('perplexity')}
            className={`mr-4 py-3 px-3 border-b-2 font-medium text-sm flex items-center space-x-1.5
              ${activeTab === 'perplexity' 
                ? 'border-blue-600 text-blue-600' 
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'}
            `}
          >
            <div className="h-3 w-3 bg-blue-500 rounded-full"></div>
            <span>Perplexity</span>
          </button>
          
          <button
            onClick={() => setActiveTab('openai')}
            className={`mr-4 py-3 px-3 border-b-2 font-medium text-sm flex items-center space-x-1.5
              ${activeTab === 'openai' 
                ? 'border-blue-600 text-blue-600' 
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'}
            `}
          >
            <div className="h-3 w-3 bg-green-500 rounded-full"></div>
            <span>OpenAI</span>
          </button>
          
          <button
            onClick={() => setActiveTab('comparison')}
            className={`mr-4 py-3 px-3 border-b-2 font-medium text-sm flex items-center space-x-1.5
              ${activeTab === 'comparison' 
                ? 'border-blue-600 text-blue-600' 
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'}
            `}
          >
            <BarChart4 className="h-4 w-4" />
            <span>Compare</span>
          </button>
          
          <button
            onClick={() => setActiveTab('certificate')}
            className={`mr-4 py-3 px-3 border-b-2 font-medium text-sm flex items-center space-x-1.5
              ${activeTab === 'certificate' 
                ? 'border-blue-600 text-blue-600' 
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'}
            `}
          >
            <Award className="h-4 w-4" />
            <span>Certificate</span>
          </button>
        </div>
      </div>
      
      {/* Tab Content */}
      <div className="overflow-hidden">
        {activeTab === 'dashboard' && (
          <div className="space-y-6">
            {/* Dashboard Header */}
            <div className="bg-blue-50 border border-blue-100 rounded-lg p-4 flex items-center">
              <Shield className="h-10 w-10 text-blue-600 mr-4" />
              <div>
                <h3 className="text-lg font-medium text-gray-900">Analysis Summary</h3>
                <p className="text-gray-700">
                  {videoTitle ? `"${videoTitle}"` : 'This video'} contains {metrics.totalClaims} empirical claim{metrics.totalClaims !== 1 ? 's' : ''}
                </p>
              </div>
            </div>
            
            {/* Metrics Cards */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {/* Truth Distribution */}
              <div className="bg-white rounded-lg border border-gray-200 p-4 shadow-sm">
                <h4 className="text-gray-700 font-medium text-sm mb-3 flex items-center">
                  <Info className="h-4 w-4 mr-1.5 text-blue-500" />
                  <span>Verification Results</span>
                </h4>
                
                <div className="flex justify-between items-center space-x-2">
                  {/* True */}
                  <div className="flex-1 bg-green-50 border border-green-100 rounded-md p-3 text-center">
                    <div className="text-lg font-semibold text-green-700">{metrics.counts.TRUE}</div>
                    <div className="text-xs text-green-600">True</div>
                  </div>
                  
                  {/* False */}
                  <div className="flex-1 bg-red-50 border border-red-100 rounded-md p-3 text-center">
                    <div className="text-lg font-semibold text-red-700">{metrics.counts.FALSE}</div>
                    <div className="text-xs text-red-600">False</div>
                  </div>
                  
                  {/* Unverified */}
                  <div className="flex-1 bg-amber-50 border border-amber-100 rounded-md p-3 text-center">
                    <div className="text-lg font-semibold text-amber-700">{metrics.counts.UNVERIFIED}</div>
                    <div className="text-xs text-amber-600">Unverified</div>
                  </div>
                </div>
              </div>
              
              {/* Confidence Score */}
              <div className="bg-white rounded-lg border border-gray-200 p-4 shadow-sm">
                <h4 className="text-gray-700 font-medium text-sm mb-3 flex items-center">
                  <BarChart2 className="h-4 w-4 mr-1.5 text-blue-500" />
                  <span>Average Confidence</span>
                </h4>
                
                <div className="flex flex-col items-center">
                  <div className="text-2xl font-bold text-blue-700">{metrics.avgConfidence}%</div>
                  <div className="mt-2 w-full bg-gray-200 rounded-full h-2">
                    <div 
                      className="bg-blue-600 h-2 rounded-full" 
                      style={{ width: `${metrics.avgConfidence}%` }}
                    ></div>
                  </div>
                  <p className="text-xs text-gray-500 mt-2">
                    Average confidence across all models and claims
                  </p>
                </div>
              </div>
              
              {/* Model Agreement */}
              <div className="bg-white rounded-lg border border-gray-200 p-4 shadow-sm">
                <h4 className="text-gray-700 font-medium text-sm mb-3 flex items-center">
                  <CheckCircle className="h-4 w-4 mr-1.5 text-blue-500" />
                  <span>Model Agreement</span>
                </h4>
                
                <div className="flex flex-col items-center">
                  <div className="text-2xl font-bold text-blue-700">{metrics.agreementRate}%</div>
                  <div className="mt-2 w-full bg-gray-200 rounded-full h-2">
                    <div 
                      className={`h-2 rounded-full ${
                        metrics.agreementRate > 75 ? 'bg-green-500' : 
                        metrics.agreementRate > 50 ? 'bg-blue-500' : 
                        metrics.agreementRate > 25 ? 'bg-amber-500' : 'bg-red-500'
                      }`}
                      style={{ width: `${metrics.agreementRate}%` }}
                    ></div>
                  </div>
                  <p className="text-xs text-gray-500 mt-2">
                    Percentage of claims where all models agree
                  </p>
                </div>
              </div>
            </div>
            
            {/* Top Claims by Importance */}
            <div className="mt-6">
              <h3 className="text-lg font-medium text-gray-900 mb-4">Key Claims</h3>
              
              <div className="space-y-4">
                {empiricalClaims.slice(0, 3).map((claim, index) => {
                  // Find matching results from each model
                  const perplexityResult = perplexityResults.find(r => r.claimId === claim.id);
                  const openAIResult = openAIResults.find(r => r.claimId === claim.id);
                  
                  // Calculate consensus classification
                  let consensusClassification = 'UNVERIFIED';
                  const classifications = [
                    perplexityResult?.classification,
                    openAIResult?.classification
                  ].filter(Boolean);
                  
                  // Count occurrences of each classification
                  const counts = classifications.reduce((acc, curr) => {
                    if (curr) {
                      acc[curr] = (acc[curr] || 0) + 1;
                    }
                    return acc;
                  }, {} as Record<string, number>);
                  
                  // Find the classification with the highest count
                  let maxCount = 0;
                  for (const [classification, count] of Object.entries(counts)) {
                    if (count > maxCount) {
                      maxCount = count;
                      consensusClassification = classification;
                    }
                  }
                  
                  // Calculate average confidence
                  const confidences = [
                    perplexityResult?.confidence,
                    openAIResult?.confidence
                  ].filter(c => typeof c === 'number') as number[];
                  
                  const avgConfidence = confidences.length > 0
                    ? Math.round(confidences.reduce((a, b) => a + b, 0) / confidences.length)
                    : 0;
                  
                  return (
                    <div key={index} className="bg-white border border-gray-200 rounded-lg shadow-sm p-4">
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <p className="font-medium text-gray-800">{claim.claim}</p>
                          
                          {claim.speaker && (
                            <div className="flex items-center mt-1 text-sm text-gray-600">
                              <Users className="h-3 w-3 mr-1" />
                              <span>Speaker: {claim.speaker.name || `Speaker ${claim.speaker.id}`}</span>
                            </div>
                          )}
                        </div>
                        
                        <div className="flex items-center ml-4">
                          <div className={`px-3 py-1 rounded-full text-sm font-medium
                            ${consensusClassification === 'TRUE' ? 'bg-green-100 text-green-700 border border-green-200' : 
                              consensusClassification === 'FALSE' ? 'bg-red-100 text-red-700 border border-red-200' :
                              'bg-amber-100 text-amber-700 border border-amber-200'}
                          `}>
                            {consensusClassification === 'TRUE' ? 'True' : 
                             consensusClassification === 'FALSE' ? 'False' : 'Unverified'}
                          </div>
                        </div>
                      </div>
                      
                      <div className="mt-3">
                        <div className="text-xs text-gray-500 mb-1">Confidence</div>
                        <div className="flex items-center">
                          <div className="w-full bg-gray-200 rounded-full h-1.5 mr-2">
                            <div 
                              className={`h-1.5 rounded-full ${
                                consensusClassification === 'TRUE' ? 'bg-green-500' : 
                                consensusClassification === 'FALSE' ? 'bg-red-500' : 'bg-amber-500'
                              }`}
                              style={{ width: `${avgConfidence}%` }}
                            ></div>
                          </div>
                          <div className="text-xs font-medium text-gray-700 whitespace-nowrap">
                            {avgConfidence}%
                          </div>
                        </div>
                      </div>
                      
                      <div className="mt-3 flex items-center text-xs text-gray-500">
                        <div className="flex items-center mr-3">
                          <div className="h-2 w-2 bg-blue-500 rounded-full mr-1"></div>
                          <span>Perplexity: {perplexityResult?.classification || 'N/A'}</span>
                        </div>
                        <div className="flex items-center">
                          <div className="h-2 w-2 bg-green-500 rounded-full mr-1"></div>
                          <span>OpenAI: {openAIResult?.classification || 'N/A'}</span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
              
              {empiricalClaims.length > 3 && (
                <button 
                  className="mt-4 w-full py-2 border border-gray-200 rounded-md text-gray-700 hover:bg-gray-50 text-sm font-medium flex items-center justify-center"
                  onClick={() => setActiveTab('claims')}
                >
                  <span>View All {empiricalClaims.length} Claims</span>
                </button>
              )}
            </div>
          </div>
        )}
        
        {activeTab === 'claims' && (
          <div className="space-y-4">
            {empiricalClaims.map((claim, index) => (
              <ClaimCard 
                key={index} 
                claim={claim} 
                index={index} 
                perplexityResult={perplexityResults.find(r => r.claimId === claim.id)} 
                openAIResult={openAIResults.find(r => r.claimId === claim.id)}
              />
            ))}
          </div>
        )}
        
        {activeTab === 'perplexity' && (
          <div className="space-y-4">
            {perplexityResults.length > 0 ? (
              perplexityResults.map((claim, index) => (
                <FactCheckCard key={index} claim={claim} />
              ))
            ) : serviceStatus.perplexity === 'loading' ? (
              <div className="py-6">
                <ServiceLoadingStatus 
                  perplexityStatus={serviceStatus.perplexity}
                  openAIStatus="idle"
                />
              </div>
            ) : (
              <div className="text-center py-10 bg-white border border-gray-200 rounded-lg">
                <AlertCircle className="h-10 w-10 text-gray-300 mx-auto mb-3" />
                <p className="text-gray-700">No verification results available from Perplexity yet.</p>
              </div>
            )}
          </div>
        )}
        
        {activeTab === 'openai' && (
          <div className="space-y-4">
            {openAIResults.length > 0 ? (
              openAIResults.map((claim, index) => (
                <FactCheckCard key={index} claim={claim} />
              ))
            ) : serviceStatus.openai === 'loading' ? (
              <div className="py-6">
                <ServiceLoadingStatus 
                  perplexityStatus="idle"
                  openAIStatus={serviceStatus.openai}
                />
              </div>
            ) : (
              <div className="text-center py-10 bg-white border border-gray-200 rounded-lg">
                <AlertCircle className="h-10 w-10 text-gray-300 mx-auto mb-3" />
                <p className="text-gray-700">No verification results available from OpenAI yet.</p>
              </div>
            )}
          </div>
        )}
        
        {activeTab === 'comparison' && (
          <ModelComparison
            perplexityResults={perplexityResults}
            openAIResults={openAIResults}
          />
        )}
        
        {activeTab === 'certificate' && (
          <VerificationCertificate
            videoTitle={videoTitle || 'Analyzed Video'}
            thumbnailUrl={thumbnailUrl}
            claims={empiricalClaims}
            perplexityResults={perplexityResults}
            openAIResults={openAIResults}
          />
        )}
      </div>
      
      <div className="mt-6 p-4 bg-gray-50 border border-gray-200 rounded-lg flex items-center justify-between">
        <div className="flex items-center">
          <Shield className="h-5 w-5 text-blue-600 mr-2" />
          <span className="text-sm text-gray-800 font-medium">Verified by Civic</span>
        </div>
        <div className="flex items-center space-x-3">
          <button className="text-xs text-blue-600 hover:text-blue-800 flex items-center">
            <ExternalLink className="h-3 w-3 mr-1" />
            <span>Share Verification</span>
          </button>
          <button className="text-xs text-blue-600 hover:text-blue-800 flex items-center">
            <Download className="h-3 w-3 mr-1" />
            <span>Download Report</span>
          </button>
        </div>
      </div>
    </div>
  );
};

export default AnalysisResults;