import React, { useRef } from 'react';
import { Award, Shield, Share2, Download, CheckCircle, XCircle, AlertTriangle, Calendar, Clock, Link, User } from 'lucide-react';
import { ClaimAnalysis, Claim } from '../../types';

interface VerificationCertificateProps {
  videoTitle: string;
  thumbnailUrl?: string;
  claims: ClaimAnalysis[];
  perplexityResults: Claim[];
  openAIResults: Claim[];
  anthropicResults: Claim[];
}

const VerificationCertificate: React.FC<VerificationCertificateProps> = ({
  videoTitle,
  thumbnailUrl,
  claims,
  perplexityResults,
  openAIResults,
  anthropicResults
}) => {
  const certificateRef = useRef<HTMLDivElement>(null);
  
  // Generate a unique certificate ID (in a real app, this would come from the backend)
  const certificateId = 'CIVIC-' + Math.random().toString(36).substring(2, 10).toUpperCase();
  
  // Format current date
  const currentDate = new Date().toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
  
  // Calculate aggregated results
  const calculateAggregatedResults = () => {
    // Count claim classifications
    const allResults = [...perplexityResults, ...openAIResults, ...anthropicResults];
    
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
    
    // Calculate agreement rate
    let agreementCount = 0;
    let totalComparisons = 0;
    
    if (perplexityResults.length === openAIResults.length && openAIResults.length === anthropicResults.length) {
      for (let i = 0; i < perplexityResults.length; i++) {
        if (perplexityResults[i].classification === openAIResults[i].classification &&
            openAIResults[i].classification === anthropicResults[i].classification) {
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
      totalClaims: claims.length
    };
  };
  
  const metrics = calculateAggregatedResults();
  
  // Function to download the certificate
  const downloadCertificate = () => {
    // In a real implementation, this would generate a PDF
    alert('Certificate download functionality would be implemented here.');
  };
  
  // Function to share the certificate
  const shareCertificate = () => {
    // In a real implementation, this would generate a shareable link
    alert('Certificate sharing functionality would be implemented here.');
  };

  return (
    <div className="space-y-6">
      {/* Certificate Actions */}
      <div className="flex justify-end space-x-3">
        <button 
          onClick={shareCertificate}
          className="flex items-center space-x-2 px-3 py-2 bg-blue-50 hover:bg-blue-100 text-blue-700 rounded-lg border border-blue-200 text-sm font-medium transition-colors"
        >
          <Share2 className="h-4 w-4" />
          <span>Share Certificate</span>
        </button>
        
        <button 
          onClick={downloadCertificate}
          className="flex items-center space-x-2 px-3 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors"
        >
          <Download className="h-4 w-4" />
          <span>Download Certificate</span>
        </button>
      </div>
      
      {/* Certificate Document */}
      <div 
        ref={certificateRef}
        className="bg-white border-2 border-blue-200 rounded-lg shadow-lg overflow-hidden max-w-2xl mx-auto"
      >
        {/* Certificate Header */}
        <div className="bg-blue-600 text-white p-6 text-center relative">
          <div className="absolute top-3 right-3 bg-white text-blue-600 text-xs font-medium px-2 py-1 rounded-full">
            {certificateId}
          </div>
          
          <Award className="h-12 w-12 mx-auto mb-3" />
          <h2 className="text-2xl font-bold mb-1">Verification Certificate</h2>
          <p className="text-blue-100">CIVIC - Advanced Video Fact Checking Platform</p>
        </div>
        
        {/* Video Info */}
        <div className="p-6 border-b border-gray-200">
          <h3 className="font-semibold text-gray-800 mb-2">Video Information</h3>
          
          <div className="flex items-start">
            {thumbnailUrl && (
              <div className="w-24 h-16 rounded overflow-hidden mr-4 flex-shrink-0">
                <img 
                  src={thumbnailUrl} 
                  alt="Video Thumbnail" 
                  className="w-full h-full object-cover"
                  onError={(e) => {
                    e.currentTarget.src = 'https://via.placeholder.com/240x160?text=No+Thumbnail';
                  }}
                />
              </div>
            )}
            
            <div className="flex-1">
              <p className="font-medium text-gray-900">{videoTitle}</p>
              
              <div className="mt-2 flex items-center space-x-4 text-xs text-gray-600">
                <div className="flex items-center">
                  <Calendar className="h-3 w-3 mr-1" />
                  <span>Verified on: {currentDate}</span>
                </div>
                
                <div className="flex items-center">
                  <Clock className="h-3 w-3 mr-1" />
                  <span>Valid for 90 days</span>
                </div>
              </div>
            </div>
          </div>
        </div>
        
        {/* Verification Summary */}
        <div className="p-6 border-b border-gray-200">
          <h3 className="font-semibold text-gray-800 mb-3">Verification Summary</h3>
          
          <div className="grid grid-cols-4 gap-4 bg-gray-50 p-4 rounded-lg border border-gray-100">
            <div className="text-center">
              <div className="text-lg font-bold text-gray-900">{metrics.totalClaims}</div>
              <div className="text-xs text-gray-600">Claims Analyzed</div>
            </div>
            
            <div className="text-center">
              <div className="text-lg font-bold text-green-600">{metrics.counts.TRUE}</div>
              <div className="text-xs text-gray-600">Verified True</div>
            </div>
            
            <div className="text-center">
              <div className="text-lg font-bold text-red-600">{metrics.counts.FALSE}</div>
              <div className="text-xs text-gray-600">Verified False</div>
            </div>
            
            <div className="text-center">
              <div className="text-lg font-bold text-amber-600">{metrics.counts.UNVERIFIED}</div>
              <div className="text-xs text-gray-600">Unverified</div>
            </div>
          </div>
          
          {/* Progress Bars */}
          <div className="mt-4 space-y-3">
            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="text-gray-700">Average Confidence</span>
                <span className="font-medium text-gray-900">{metrics.avgConfidence}%</span>
              </div>
              <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
                <div 
                  className="h-full bg-blue-600 rounded-full"
                  style={{ width: `${metrics.avgConfidence}%` }}
                ></div>
              </div>
            </div>
            
            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="text-gray-700">Model Agreement</span>
                <span className="font-medium text-gray-900">{metrics.agreementRate}%</span>
              </div>
              <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
                <div 
                  className={`h-full rounded-full ${
                    metrics.agreementRate > 75 ? 'bg-green-500' : 
                    metrics.agreementRate > 50 ? 'bg-blue-500' : 
                    metrics.agreementRate > 25 ? 'bg-amber-500' : 'bg-red-500'
                  }`}
                  style={{ width: `${metrics.agreementRate}%` }}
                ></div>
              </div>
            </div>
          </div>
        </div>
        
        {/* Verification Details */}
        <div className="p-6 border-b border-gray-200">
          <h3 className="font-semibold text-gray-800 mb-3">Key Claims Analysis</h3>
          
          <div className="space-y-4 max-h-[300px] overflow-y-auto">
            {claims.slice(0, 5).map((claim, index) => {
              // Find matching results from each model
              const perplexityResult = perplexityResults.find(r => r.claimId === claim.id);
              const openAIResult = openAIResults.find(r => r.claimId === claim.id);
              const anthropicResult = anthropicResults.find(r => r.claimId === claim.id);
              
              // Calculate consensus classification
              let consensusClassification = 'UNVERIFIED';
              const classifications = [
                perplexityResult?.classification,
                openAIResult?.classification,
                anthropicResult?.classification
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
              
              return (
                <div key={index} className="flex items-start border-b border-gray-100 pb-3 last:border-b-0 last:pb-0">
                  <div className="flex-shrink-0 mr-3 mt-1">
                    {consensusClassification === 'TRUE' ? (
                      <CheckCircle className="h-5 w-5 text-green-500" />
                    ) : consensusClassification === 'FALSE' ? (
                      <XCircle className="h-5 w-5 text-red-500" />
                    ) : (
                      <AlertTriangle className="h-5 w-5 text-amber-500" />
                    )}
                  </div>
                  
                  <div className="flex-1">
                    <p className="text-sm text-gray-800">{claim.claim}</p>
                    
                    {claim.speaker && (
                      <div className="mt-1 flex items-center text-xs text-gray-600">
                        <User className="h-3 w-3 mr-1" />
                        <span>Speaker: {claim.speaker.name || `Speaker ${claim.speaker.id}`}</span>
                      </div>
                    )}
                    
                    <div className="mt-1 flex items-center text-xs">
                      <div className="flex items-center mr-3">
                        <div className="h-2 w-2 bg-blue-500 rounded-full mr-1"></div>
                        <span className="text-gray-600">Perplexity:</span>
                        <span className={`ml-1 font-medium ${
                          perplexityResult?.classification === 'TRUE' ? 'text-green-600' :
                          perplexityResult?.classification === 'FALSE' ? 'text-red-600' :
                          'text-amber-600'
                        }`}>
                          {perplexityResult?.classification || 'N/A'}
                        </span>
                      </div>
                      
                      <div className="flex items-center mr-3">
                        <div className="h-2 w-2 bg-green-500 rounded-full mr-1"></div>
                        <span className="text-gray-600">OpenAI:</span>
                        <span className={`ml-1 font-medium ${
                          openAIResult?.classification === 'TRUE' ? 'text-green-600' :
                          openAIResult?.classification === 'FALSE' ? 'text-red-600' :
                          'text-amber-600'
                        }`}>
                          {openAIResult?.classification || 'N/A'}
                        </span>
                      </div>
                      
                      <div className="flex items-center">
                        <div className="h-2 w-2 bg-purple-500 rounded-full mr-1"></div>
                        <span className="text-gray-600">Anthropic:</span>
                        <span className={`ml-1 font-medium ${
                          anthropicResult?.classification === 'TRUE' ? 'text-green-600' :
                          anthropicResult?.classification === 'FALSE' ? 'text-red-600' :
                          'text-amber-600'
                        }`}>
                          {anthropicResult?.classification || 'N/A'}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
            
            {claims.length > 5 && (
              <div className="text-center text-sm text-gray-500 italic">
                {claims.length - 5} more claims available in the full report
              </div>
            )}
          </div>
        </div>
        
        {/* Certificate Footer */}
        <div className="p-6 border-t border-gray-200 bg-gray-50 flex items-center justify-between text-sm">
          <div className="flex items-center text-gray-700">
            <Shield className="h-4 w-4 mr-2 text-blue-600" />
            <span>Verified by Civic Technology</span>
          </div>
          
          <div className="flex items-center text-gray-600">
            <Link className="h-3 w-3 mr-1" />
            <span>verify.civic-tech.org/{certificateId}</span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default VerificationCertificate;