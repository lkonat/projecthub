export default {
  id: 'research',
  label: 'Research',
  description: 'Open-ended exploration without a fixed deliverable.',
  defaults: {
    priority: 'medium',
  },
  fields: [
    { key: 'question',      label: 'Research question', type: 'textarea', required: true },
    { key: 'shareable',     label: 'Shareable publicly', type: 'boolean', required: false },
  ],
};
