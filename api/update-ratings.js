// api/update-ratings.js
require('dotenv').config();
const { MongoClient } = require('mongodb');
const axios = require('axios');

const MONGODB_URI = process.env.MONGO_URI;
const SHIKIMORI_API = 'https://shikimori.one/api/graphql';
const SHIKIMORI_TOKEN = process.env.SHIKIMORI_TOKEN; // Новый токен из .env

let isUpdating = false;
let shouldStop = false;
const logStream = [];

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function log(message, level = 'info') {
  const logEntry = { message, level, timestamp: new Date().toISOString() };
  logStream.push(logEntry);
  console[level](message);
}

async function findAnimeId(anime) {
  const searchTitles = [];
  if (anime.Title) searchTitles.push(anime.Title);
  if (anime.TitleEng) searchTitles.push(anime.TitleEng);
  if (anime.title) searchTitles.push(anime.title);
  
  if (searchTitles.length === 0) {
    log('No title found for anime: ' + JSON.stringify(anime), 'warn');
    return null;
  }
  
  const searchQuery = `
    query ($search: String) {
      animes(search: $search, limit: 5) {
        id
        name
        russian
      }
    }
  `;
  
  for (const title of searchTitles) {
    try {
      log(`Searching Shikimori for: "${title}"`);
      const response = await axios.post(SHIKIMORI_API, {
        query: searchQuery,
        variables: { search: title }
      }, {
        headers: {
          'User-Agent': 'AnimeRatingUpdater',
          'Content-Type': 'application/json',
          ...(SHIKIMORI_TOKEN && { 'Authorization': `Bearer ${SHIKIMORI_TOKEN}` }) // Добавляем токен, если он есть
        }
      });

      const results = response.data.data?.animes;
      if (!results) {
        log(`No results from Shikimori API for "${title}"`, 'warn');
        continue;
      }

      log(`Found ${results.length} results for "${title}"`);
      for (const result of results) {
        const resultRussian = result.russian?.toLowerCase() || '';
        const resultName = result.name?.toLowerCase() || '';
        const searchTitleLower = title.toLowerCase();
        
        if (resultRussian === searchTitleLower || resultName === searchTitleLower) {
          log(`Exact match found for "${title}" with ID: ${result.id}`);
          return result.id;
        }
      }
      
      log(`No exact match for "${title}", using best guess: ${results[0].russian || results[0].name} (ID: ${results[0].id})`);
      return results[0].id;
    } catch (error) {
      log(`Shikimori search error for "${title}": ${error.message}`, 'error');
    }
    await delay(500);
  }
  return null;
}

async function getShikimoriData(animeId) {
  const query = `
    query ($id: ID) {
      animes(ids: [$id]) {
        id
        score
        episodes
        status
        url
        genres {
          name
          russian
        }
        studios {
          name
        }
        externalLinks {
          kind
          url
        }
      }
    }
  `;

  try {
    log(`Fetching details for anime ID: ${animeId}`);
    const response = await axios.post(SHIKIMORI_API, {
      query,
      variables: { id: animeId }
    }, {
      headers: {
        'User-Agent': 'AnimeRatingUpdater',
        'Content-Type': 'application/json',
        ...(SHIKIMORI_TOKEN && { 'Authorization': `Bearer ${SHIKIMORI_TOKEN}` }) // Добавляем токен, если он есть
      }
    });

    log(`Raw response from Shikimori for ID ${animeId}: ${JSON.stringify(response.data)}`);
    
    const anime = response.data.data?.animes[0];
    if (!anime) {
      log(`No anime data returned for ID: ${animeId}. Full response: ${JSON.stringify(response.data)}`, 'warn');
      return null;
    }

    log(`Successfully fetched data for ID: ${animeId}. Score: ${anime.score}, Episodes: ${anime.episodes}`);
    return {
      score: anime.score,
      episodes: anime.episodes,
      status: anime.status,
      url: anime.url,
      genres: anime.genres.map(g => ({ name: g.name, russian: g.russian })),
      studios: anime.studios.map(s => s.name),
      externalLinks: anime.externalLinks.map(l => ({ kind: l.kind, url: l.url }))
    };
  } catch (error) {
    log(`Shikimori API error for ID ${animeId}: ${error.message}. Response: ${error.response?.data ? JSON.stringify(error.response.data) : 'No response'}`, 'error');
    return null;
  }
}

async function updateRatings() {
  if (isUpdating) {
    log('Update already in progress', 'warn');
    return { error: 'Update already in progress' };
  }

  if (!SHIKIMORI_TOKEN) {
    log('SHIKIMORI_TOKEN is not set in environment variables', 'error');
  }

  isUpdating = true;
  shouldStop = false;
  logStream.length = 0;

  let client;
  try {
    log('Connecting to MongoDB');
    client = new MongoClient(MONGODB_URI);
    await client.connect();
    const db = client.db('anime_db');
    const collection = db.collection('anime_list');
    
    log('Fetching anime list from database');
    const animeList = await collection.find({}).toArray();
    
    if (!animeList.length) {
      log('No anime found in database!', 'error');
      return { error: 'No anime found in database' };
    }

    const stats = {
      total: animeList.length,
      updated: 0,
      failed: 0,
      notFound: 0
    };
    log(`Found ${animeList.length} anime titles in database`);

    for (let i = 0; i < animeList.length && !shouldStop; i++) {
      const anime = animeList[i];
      const animeId = await findAnimeId(anime);
      
      if (animeId) {
        const data = await getShikimoriData(animeId);
        
        if (data) {
          log(`Updating database for anime: ${anime.Title || anime.TitleEng || anime.title}`);
          await collection.updateOne(
            { _id: anime._id },
            {
              $set: {
                imdbRating: data.score,
                Episodes: data.episodes,
                status: data.status,
                url: `https://shikimori.one${data.url}`,
                genres: data.genres,
                studios: data.studios,
                externalLinks: data.externalLinks,
                updatedAt: new Date()
              }
            }
          );
          stats.updated++;
          log(`[${i+1}/${animeList.length}] Updated: ${anime.Title || anime.TitleEng || anime.title}`);
        } else {
          stats.failed++;
          log(`[${i+1}/${animeList.length}] Failed to get data for: ${anime.Title || anime.TitleEng || anime.title}`, 'error');
        }
      } else {
        stats.notFound++;
        log(`[${i+1}/${animeList.length}] Anime not found on Shikimori: ${anime.Title || anime.TitleEng || anime.title}`, 'warn');
      }
      
      if (i < animeList.length - 1) {
        await delay(1000);
      }
    }

    const report = {
      message: shouldStop ? 'Update stopped' : 'Update completed',
      stats,
      stopped: shouldStop
    };
    
    log('Update finished', 'info');
    return report;
  } catch (error) {
    log(`Error in updateRatings: ${error.message}`, 'error');
    throw error;
  } finally {
    isUpdating = false;
    if (client) {
      log('Closing MongoDB connection');
      await client.close();
    }
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  if (req.method === 'GET') {
    if (req.query.action === 'stop') {
      shouldStop = true;
      return res.status(200).json({ message: 'Stop signal sent' });
    } else if (req.query.action === 'logs') {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const sendLogs = () => {
        res.write(`data: ${JSON.stringify(logStream)}\n\n`);
        if (!isUpdating) {
          res.end();
        }
      };

      const interval = setInterval(sendLogs, 1000);
      req.on('close', () => {
        clearInterval(interval);
        res.end();
      });
    } else {
      try {
        const result = await updateRatings();
        res.status(200).json(result);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    }
  } else {
    res.status(405).json({ error: 'Method not allowed' });
  }
};