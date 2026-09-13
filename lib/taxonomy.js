// Two-level domain.topic tag vocabulary. Leaf keywords shortlist candidates by lexical
// match before a model picks 2-5. Kept in the hundreds, not thousands: cross-model
// assignment consistency collapses as the label space grows. Custom tags use `x.`.

const TAXONOMY = {
  health: {
    appointment: ['doctor', 'dentist', 'appointment', 'checkup', 'clinic', 'physician'],
    medication: ['medication', 'prescription', 'pills', 'dosage', 'pharmacy'],
    fitness: ['workout', 'gym', 'exercise', 'running', 'yoga', 'training', 'marathon'],
    symptom: ['pain', 'symptom', 'injury', 'allergy', 'allergic', 'fever', 'headache'],
    mental: ['stress', 'anxiety', 'therapy', 'therapist', 'meditation', 'burnout'],
    nutrition: ['diet', 'calories', 'protein', 'vitamin', 'nutrition', 'vegetarian', 'vegan'],
  },
  finance: {
    budget: ['budget', 'spending', 'expenses', 'saving', 'savings'],
    banking: ['bank', 'account', 'transfer', 'deposit', 'interest', 'loan', 'mortgage'],
    investing: ['invest', 'stocks', 'portfolio', 'shares', 'retirement', 'fund'],
    taxes: ['tax', 'taxes', 'deduction', 'refund', 'filing'],
    purchase: ['bought', 'purchase', 'price', 'paid', 'cost', 'deal', 'discount'],
    insurance: ['insurance', 'policy', 'premium', 'claim', 'coverage'],
  },
  career: {
    job_search: ['resume', 'interview', 'application', 'recruiter', 'hiring', 'linkedin'],
    workplace: ['meeting', 'manager', 'colleague', 'deadline', 'office', 'project', 'promotion'],
    skills: ['course', 'certification', 'training', 'learning', 'skill', 'workshop', 'webinar'],
    business: ['startup', 'client', 'revenue', 'marketing', 'customer', 'contract'],
  },
  education: {
    school: ['school', 'college', 'university', 'degree', 'graduate', 'graduated', 'campus'],
    study: ['exam', 'homework', 'studying', 'thesis', 'grade', 'semester', 'class'],
    language: ['language', 'spanish', 'french', 'vocabulary', 'fluent', 'duolingo'],
  },
  travel: {
    trip: ['trip', 'vacation', 'travel', 'itinerary', 'destination', 'sightseeing'],
    flight: ['flight', 'airport', 'airline', 'boarding', 'layover'],
    lodging: ['hotel', 'airbnb', 'hostel', 'booking', 'reservation', 'check-in'],
    local: ['commute', 'train', 'subway', 'bus', 'taxi', 'uber'],
  },
  food: {
    cooking: ['recipe', 'cooking', 'baking', 'ingredients', 'oven', 'dish'],
    dining: ['restaurant', 'dinner', 'lunch', 'brunch', 'reservation', 'menu', 'cafe'],
    drink: ['coffee', 'wine', 'beer', 'cocktail', 'tea', 'brewery'],
  },
  home: {
    housing: ['apartment', 'house', 'rent', 'lease', 'landlord', 'moving', 'roommate'],
    maintenance: ['repair', 'plumber', 'renovation', 'furniture', 'cleaning', 'leak'],
    garden: ['garden', 'plants', 'lawn', 'flowers', 'vegetables', 'compost'],
    utilities: ['electricity', 'internet', 'utility', 'wifi', 'heating', 'bill'],
  },
  family: {
    parenting: ['kids', 'children', 'baby', 'daughter', 'son', 'school run', 'daycare'],
    relatives: ['parents', 'mother', 'father', 'sister', 'brother', 'grandma', 'aunt'],
    partner: ['wife', 'husband', 'girlfriend', 'boyfriend', 'anniversary', 'wedding', 'date night'],
    pets: ['dog', 'cat', 'vet', 'puppy', 'kitten', 'pet'],
  },
  social: {
    friends: ['friends', 'hangout', 'party', 'birthday', 'gathering', 'reunion'],
    community: ['volunteer', 'charity', 'club', 'church', 'neighborhood', 'donation'],
    events: ['concert', 'festival', 'show', 'tickets', 'exhibition', 'museum'],
  },
  vehicles: {
    car: ['car', 'vehicle', 'driving', 'license', 'dealership', 'sedan', 'suv'],
    maintenance: ['oil change', 'mechanic', 'tires', 'service', 'brake', 'engine', 'gps'],
    bike: ['bike', 'bicycle', 'cycling', 'helmet', 'e-bike'],
  },
  technology: {
    devices: ['phone', 'laptop', 'computer', 'tablet', 'headphones', 'camera', 'monitor'],
    software: ['app', 'software', 'update', 'password', 'account', 'backup', 'subscription'],
    coding: ['code', 'programming', 'python', 'javascript', 'github', 'database', 'api'],
    gaming: ['game', 'gaming', 'console', 'playstation', 'xbox', 'nintendo', 'steam'],
  },
  entertainment: {
    screen: ['movie', 'film', 'series', 'netflix', 'episode', 'cinema', 'documentary'],
    reading: ['book', 'novel', 'reading', 'author', 'kindle', 'library'],
    music: ['music', 'album', 'playlist', 'song', 'band', 'spotify', 'guitar', 'piano'],
    art: ['painting', 'drawing', 'photography', 'craft', 'pottery', 'knitting'],
  },
  sports: {
    playing: ['soccer', 'basketball', 'tennis', 'golf', 'swimming', 'hiking', 'climbing', 'skiing'],
    watching: ['match', 'game', 'season', 'team', 'league', 'playoffs', 'championship'],
  },
  life_admin: {
    documents: ['passport', 'visa', 'id', 'certificate', 'notary', 'paperwork', 'renewal'],
    legal: ['lawyer', 'contract', 'court', 'dispute', 'will', 'attorney'],
    scheduling: ['calendar', 'schedule', 'reminder', 'planning', 'deadline', 'postponed'],
    shopping: ['order', 'delivery', 'amazon', 'return', 'shipping', 'store'],
  },
};

// flat list: [{tag: 'health.appointment', keywords: [...]}, ...]
const TAGS = [];
for (const [domain, topics] of Object.entries(TAXONOMY)) {
  for (const [topic, keywords] of Object.entries(topics)) {
    TAGS.push({ tag: `${domain}.${topic}`, keywords: [topic, ...keywords].map(k => k.toLowerCase()) });
  }
}

// Deterministic shortlist: rank registry tags by keyword hits in the text.
function candidateTags(text, n = 10) {
  const t = String(text).toLowerCase();
  return TAGS.map(x => ({ tag: x.tag, score: x.keywords.filter(k => t.includes(k)).length }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
    .map(x => x.tag);
}

module.exports = { TAXONOMY, TAGS, candidateTags };
