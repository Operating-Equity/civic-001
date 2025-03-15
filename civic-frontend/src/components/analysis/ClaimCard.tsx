import React from 'react';
import { AlertCircle } from 'lucide-react';
import { ClaimAnalysis } from '../../types';

interface ClaimCardProps {
  claim: ClaimAnalysis;
}

const ClaimCard: React.FC<ClaimCardProps> = ({ claim }) => {
  return (
    <div className="glass-panel p-6">
      <div className="flex items-center space-x-2 mb-4">
        <AlertCircle className="h-5 w-5 text-primary" />
        <h2 className="text-xl font-semibold text-white">Empirical Claim</h2>
      </div>
      
      <div className="space-y-4">
        <div>
          <h3 className="font-semibold text-white mb-2">Claim:</h3>
          <p className="text-white/90">{claim.claim}</p>
        </div>
        
        <div>
          <h3 className="font-semibold text-white mb-2">Context:</h3>
          <p className="text-white/90 whitespace-pre-line">{claim.context}</p>
        </div>
        
        <div>
          <h3 className="font-semibold text-white mb-2">Validation Approach:</h3>
          <p className="text-white/90">{claim.validationPotential}</p>
        </div>
      </div>
    </div>
  );
};

export default ClaimCard;