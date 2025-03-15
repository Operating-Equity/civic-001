import React, { useState } from 'react';
import { ChevronDown, ChevronUp, ExternalLink } from 'lucide-react';
import StatusBadge from '../ui/StatusBadge';
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
  
  const renderDetailedAnalysis = () => {
    const analysis = claim.detailedAnalysis;
    if (!analysis) return null;
    
    return (
      <div className="mt-4 space-y-4">
        {analysis.definitions && analysis.definitions.length > 0 && (
          <div className="space-y-1">
            <h4 className="text-white font-medium">Definitions</h4>
            <ul className="list-disc pl-5 text-white/90 text-sm">
              {analysis.definitions.map((definition, index) => (
                <li key={index}>{definition}</li>
              ))}
            </ul>
          </div>
        )}
        
        {analysis.principles && analysis.principles.length > 0 && (
          <div className="space-y-1">
            <h4 className="text-white font-medium">Principles</h4>
            <ul className="list-disc pl-5 text-white/90 text-sm">
              {analysis.principles.map((principle, index) => (
                <li key={index}>{principle}</li>
              ))}
            </ul>
          </div>
        )}
        
        {analysis.evidence && analysis.evidence.length > 0 && (
          <div className="space-y-1">
            <h4 className="text-white font-medium">Evidence</h4>
            <ul className="list-disc pl-5 text-white/90 text-sm">
              {analysis.evidence.map((item, index) => (
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
                          {item.source.substring(0, 50)}...
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
        
        {analysis.analysis && (
          <div className="space-y-1">
            <h4 className="text-white font-medium">Analysis</h4>
            <p className="text-white/90 text-sm whitespace-pre-line">{analysis.analysis}</p>
          </div>
        )}
        
        {analysis.conclusion && (
          <div className="space-y-1">
            <h4 className="text-white font-medium">Conclusion</h4>
            <p className="text-white/90 text-sm">{analysis.conclusion}</p>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="glass-panel p-6">
      <div className="flex justify-between items-start mb-4">
        <div className="space-y-2">
          <p className="font-medium text-white text-lg">{claim.statement}</p>
          <StatusBadge status={claim.classification} />
        </div>
        
        <div className="flex items-center space-x-3">
          <div className="text-sm text-white bg-white/10 px-3 py-1 rounded-full">
            Confidence: {claim.confidence?.toFixed(1) ?? 0}%
          </div>
          
          {claim.model && (
            <div className="text-xs text-white/70 bg-white/5 px-2 py-1 rounded-full">
              {claim.model}
            </div>
          )}
        </div>
      </div>

      <div className="text-white/90 text-sm">
        {expanded ? (
          <>
            {claim.detailedAnalysis ? (
              renderDetailedAnalysis()
            ) : (
              <div 
                className="text-white/90 whitespace-pre-line"
                dangerouslySetInnerHTML={{ __html: formatSupportingFacts(claim.supportingFacts) }}
              />
            )}
          </>
        ) : (
          <div className="line-clamp-3 text-white/90">
            {claim.supportingFacts.substring(0, 200)}...
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
            Show More
          </>
        )}
      </button>
    </div>
  );
};

export default FactCheckCard;
