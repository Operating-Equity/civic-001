import React, { useState } from 'react';
import { ChevronDown, ChevronUp, ExternalLink, BarChart2 } from 'lucide-react';
import { Claim } from '../../types';

interface FactCheckCardProps {
  claim: Claim;
}

const FactCheckCard: React.FC<FactCheckCardProps> = ({ claim }) => {
  const [expanded, setExpanded] = useState(false);
  
  const formatSupportingFacts = (text: string) => {
    // Convert markdown-like syntax to HTML
    // Convert bold
    let formatted = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    
    // Convert lists
    const lines = formatted.split('\n');
    let inList = false;
    const processedLines = lines.map(line => {
      const trimmedLine = line.trim();
      if (trimmedLine.startsWith('- ') || trimmedLine.startsWith('* ')) {
        if (!inList) {
          inList = true;
          return '<ul class="list-disc pl-6 mt-2 mb-2"><li>' + trimmedLine.substring(2) + '</li>';
        }
        return '<li>' + trimmedLine.substring(2) + '</li>';
      } else if (inList) {
        inList = false;
        return '</ul>' + line;
      }
      return line;
    });
    
    if (inList) {
      processedLines.push('</ul>');
    }
    
    // Replace line breaks with <br />
    return processedLines.join('\n').replace(/\n/g, '<br />');
  };
  
  const getVerificationBadge = () => {
    switch (claim.classification) {
      case 'TRUE':
        return (
          <div className="px-3 py-1.5 bg-status-true/10 text-status-true border border-status-true/20 rounded-full font-medium text-sm flex items-center">
            <svg className="w-4 h-4 mr-1.5" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M7.75 12.75L10 15.25L16.25 8.75" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2"/>
            </svg>
            Verified True
          </div>
        );
      case 'FALSE':
        return (
          <div className="px-3 py-1.5 bg-status-false/10 text-status-false border border-status-false/20 rounded-full font-medium text-sm flex items-center">
            <svg className="w-4 h-4 mr-1.5" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M15 9L9 15M9 9L15 15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2"/>
            </svg>
            False Claim
          </div>
        );
      case 'UNVERIFIED':
      default:
        return (
          <div className="px-3 py-1.5 bg-status-unverified/10 text-status-unverified border border-status-unverified/20 rounded-full font-medium text-sm flex items-center">
            <svg className="w-4 h-4 mr-1.5" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M12 16V12M12 8H12.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2"/>
            </svg>
            Needs Verification
          </div>
        );
    }
  };

  return (
    <div className="glass-panel p-6">
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-start gap-4 mb-4">
        <div className="space-y-3">
          <div>
            {getVerificationBadge()}
          </div>
          <p className="font-medium text-white text-lg leading-tight">{claim.statement}</p>
        </div>
        
        <div className="flex flex-col items-end gap-2">
          <div className="flex items-center space-x-1.5 gap-1.5">
            <div className="flex items-center bg-white/10 px-3 py-1 rounded-lg text-sm">
              <BarChart2 className="h-3.5 w-3.5 text-white/70 mr-1.5" />
              <span className="text-white font-medium">{claim.confidence}%</span>
              <span className="text-white/70 ml-1">confidence</span>
            </div>
            
            {claim.model && (
              <div className="text-xs text-white/70 bg-white/5 px-2 py-1 rounded-lg border border-white/10">
                {claim.model}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="text-white/90 text-sm">
        {claim.error ? (
          <div className="p-4 mb-4 border border-yellow-500/30 rounded-lg bg-yellow-500/5">
            <div className="flex items-center">
              <svg className="w-5 h-5 mr-2 text-yellow-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <h3 className="text-base font-medium text-yellow-500">Verification Issue</h3>
            </div>
            <div className="mt-2 text-yellow-200">
              <p>{claim.error}</p>
            </div>
          </div>
        ) : expanded ? (
          <>
            <div className="p-4 rounded-lg bg-white/5 border border-white/10">
              {claim.detailedAnalysis ? (
                <div className="space-y-4">
                  {claim.detailedAnalysis.analysis && (
                    <div>
                      <h4 className="text-white font-medium mb-2">Analysis</h4>
                      <p className="text-white/90 whitespace-pre-line">{claim.detailedAnalysis.analysis}</p>
                    </div>
                  )}
                  
                  {claim.detailedAnalysis.evidence && claim.detailedAnalysis.evidence.length > 0 && (
                    <div>
                      <h4 className="text-white font-medium mb-2">Evidence</h4>
                      <ul className="list-disc pl-5 text-white/90 space-y-2">
                        {claim.detailedAnalysis.evidence.map((item, index) => (
                          <li key={index}>
                            {item.fact}
                            {item.source && (
                              <div className="text-xs text-white/70 mt-1">
                                Source: {item.source.startsWith('http') ? (
                                  <a 
                                    href={item.source} 
                                    target="_blank" 
                                    rel="noopener noreferrer"
                                    className="text-primary hover:underline inline-flex items-center"
                                  >
                                    {item.source.substring(0, 40)}...
                                    <ExternalLink className="h-3 w-3 ml-1" />
                                  </a>
                                ) : item.source}
                              </div>
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  
                  {claim.detailedAnalysis.conclusion && (
                    <div>
                      <h4 className="text-white font-medium mb-2">Conclusion</h4>
                      <p className="text-white/90">{claim.detailedAnalysis.conclusion}</p>
                    </div>
                  )}
                </div>
              ) : claim.supportingFacts ? (
                <div 
                  className="text-white/90 text-sm"
                  dangerouslySetInnerHTML={{ __html: formatSupportingFacts(claim.supportingFacts) }}
                />
              ) : (
                <div className="text-white/70 italic">
                  No supporting facts available for this claim.
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="p-4 rounded-lg bg-white/5 line-clamp-3 text-white/90 border border-white/10">
            {claim.supportingFacts ? 
              `${claim.supportingFacts.substring(0, 200)}...` : 
              claim.error ? 
                `Error: ${claim.error}` : 
                'No supporting facts available for this claim.'
            }
          </div>
        )}
      </div>
      
      <button
        onClick={() => setExpanded(!expanded)}
        className="mt-4 flex items-center text-primary hover:text-primary-400 text-sm font-medium"
      >
        {expanded ? (
          <>
            <ChevronUp className="h-4 w-4 mr-1" />
            Show Less
          </>
        ) : (
          <>
            <ChevronDown className="h-4 w-4 mr-1" />
            Show Verification Details
          </>
        )}
      </button>
    </div>
  );
};

export default FactCheckCard;