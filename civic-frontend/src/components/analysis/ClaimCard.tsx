import React from 'react';
import { AlertCircle } from 'lucide-react';
import { ClaimAnalysis } from '../../types';

interface ClaimCardProps {
  claim: ClaimAnalysis;
  index?: number;
}

const ClaimCard: React.FC<ClaimCardProps> = ({ claim, index }) => {
  return (
    <div className="glass-panel p-6">
      <div className="flex items-start mb-4">
        {index !== undefined && (
          <div className="flex-shrink-0 h-8 w-8 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center font-medium mr-3">
            {index + 1}
          </div>
        )}
        <div className="flex items-center space-x-2">
          <AlertCircle className="h-5 w-5 text-blue-600" />
          <h2 className="text-xl font-semibold text-gray-900">Empirical Claim</h2>
        </div>
      </div>
      
      <div className="space-y-4">
        <div>
          <h3 className="font-semibold text-gray-800 mb-2">Claim:</h3>
          <p className="text-gray-700 p-3 bg-white border border-gray-200 rounded-lg shadow-sm">{claim.claim}</p>
        </div>
        
        <div>
          <h3 className="font-semibold text-gray-800 mb-2">Context:</h3>
          <p className="text-gray-700 whitespace-pre-line p-3 bg-white border border-gray-200 rounded-lg shadow-sm">{claim.context}</p>
        </div>
        
        <div>
          <h3 className="font-semibold text-gray-800 mb-2">Validation Approach:</h3>
          <p className="text-gray-700 p-3 bg-white border border-gray-200 rounded-lg shadow-sm">{claim.validationPotential}</p>
        </div>
      </div>
    </div>
  );
};

export default ClaimCard;