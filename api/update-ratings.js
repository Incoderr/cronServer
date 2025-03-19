require('dotenv').config();
const { MongoClient } = require('mongodb');
const axios = require('axios');

const MONGODB_URI = process.env.MONGO_URI;
const SHIKIMORI_API = 'https://shikimori.one/api/graphql';

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

// Поиск ID аниме
async function findAnimeId(anime) {
  const searchTitles = [];
  if (anime.Title) searchTitles.push(anime.Title);
  if (anime.TitleEng) searchTitles.push(anime.TitleEng);
  if (anime.title) searchTitles.push(anime.title);
  
  if (searchTitles.length === 0) {
    logger.warn('No title found for anime:', anime._id);
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
      logger.info(`Searching for: "${title}"`);
      const response = await axios.post(SHIKIMORI_API, {
        query: searchQuery,
        variables: { search: title }
      }, {
        headers: {
          'User-Agent': 'AnimeRatingUpdater',
          'Content-Type': 'application/json'
        }
      });

      const results = response.data.data?.animes;
      if (results && results.length > 0) {
        for (const result of results) {
          const resultRussian = result.russian?.toLowerCase() || '';
          const resultName = result.name?.toLowerCase() || '';
          const searchTitleLower = title.toLowerCase();
          
          if (resultRussian === searchTitleLower || resultName === searchTitleLower) {
            logger.info(`Exact match found for "${title}" with ID: ${result.id}`);
            return result.id;
          }
        }
        logger.info(`No exact match for "${title}", using best guess: ${results[0].russian || results[0].name} (ID: ${results[0].id})`);
        return results[0].id;
      }
    } catch (error) {
      logger.error(`Shikimori search error for "${title}":`, error.message);
    }
    await delay(500);
  }
  return null;
}

// Получение данных аниме
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
    const response = await axios.post(SHIKIMORI_API, {
      query,
      variables: { id: animeId }
    }, {
      headers: {
        'User-Agent': 'AnimeRatingUpdater',
        'Content-Type': 'application/json'
      }
    });

    const anime = response.data.data?.animes[0];
    if (anime) {
      return {
        score: anime.score,
        episodes: anime.episodes,
        status: anime.status,
        url: anime.url,
        genres: anime.genres.map(g => ({ name: g.name, russian: g.russian })),
        studios: anime.studios.map(s => s.name),
        externalLinks: anime.externalLinks.map(l => ({ kind: l.kind, url: l.url }))
      };
    }
    return null;
  } catch (error) {
    logger.error(`Shikimori API error for ID ${animeId}:`, error.message);
    return null;
  }
}

// Основная функция обновления
async function updateRatings() {
  if (isUpdating) {
    return { error: 'Update already in progress' };
  }

  isUpdating = true;
  shouldStop = false;
  logStream.length = 0; // Очищаем старые логи

  let client;
  try {
    const stats = {
      total: 0,
      updated: 0,
      failed: 0,
      notFound: 0
    };

    client = new MongoClient(MONGODB_URI);
    await client.connect();
    const db = client.db('anime_db');
    const collection = db.collection('anime_list');
    
    const animeList = await collection.find({}).toArray();
    stats.total = animeList.length;
    log(`Found ${animeList.length} anime titles in database`);

    for (let i = 0; i < animeList.length && !shouldStop; i++) {
      const anime = animeList[i];
      const animeId = await findAnimeId(anime);
      
      if (animeId) {
        const data = await getShikimoriData(animeId);
        
        if (data) {
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
    
    log('Update finished:', 'info');
    return report;
  } catch (error) {
    log(`Error updating ratings: ${error.message}`, 'error');
    throw error;
  } finally {
    isUpdating = false;
    if (client) await client.close();
  }
}

module.exports = async (req, res) => {
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
      const result = await updateRatings();
      res.status(200).json(result);
    }
  } else {
    res.status(405).json({ error: 'Method not allowed' });
  }
};