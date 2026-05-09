import requests
import os
from dotenv import load_dotenv

# Load API key from .env file
load_dotenv()
API_KEY = os.getenv("OPENWEATHER_API_KEY")
print(f"Key loaded: {API_KEY}")

def get_weather(city):
    url = "https://api.openweathermap.org/data/2.5/weather"

    params = {
        "q": city,
        "appid": API_KEY,
        "units": "imperial"  # use "metric" for Celsius
    }

    response = requests.get(url, params=params)
    print(f"Status code: {response.status_code}")
    print(f"Full response: {response.json()}")
    data = response.json()

    if response.status_code == 200:
        print(f"City: {data['name']}")
        print(f"Temperature: {data['main']['temp']}°F")
        print(f"Feels like: {data['main']['feels_like']}°F")
        print(f"Condition: {data['weather'][0]['description']}")
        print(f"Humidity: {data['main']['humidity']}%")
    else:
        print(f"Error: {data['message']}")


# Run it
get_weather("Dallas")